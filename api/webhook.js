'use strict';

/**
 * ╔══════════════════════════════════════════════════════════════╗
 *  Shopify Order Screening — Vercel Serverless Function
 *  Triggers on every new order via Shopify webhook (orders/create)
 *  Runs 3 checks and applies tags automatically.
 * ╚══════════════════════════════════════════════════════════════╝
 */

const crypto = require('crypto');

// ─────────────────────────────────────────────────────────────────────
//  1. ENVIRONMENT CONFIG
// ─────────────────────────────────────────────────────────────────────
const SHOPIFY_STORE          = process.env.SHOPIFY_STORE;           // e.g. mystore.myshopify.com
const SHOPIFY_ACCESS_TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;    // shpat_xxxx
const SHOPIFY_WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET;  // from Shopify notifications page
const BOSTA_API_KEY          = process.env.BOSTA_API_KEY;
const BOSTA_API_BASE         = process.env.BOSTA_API_BASE || 'https://app.bosta.co/api/v0';
const SHOPIFY_API_VERSION    = '2025-01';

// Tag strings — exact text including emoji
const TAG = {
  AVG_RATE:     'Average Acceptance rate 🟡',
  CALL_CONFIRM: 'call to confirm ☎️',
  LOW_RATE:     'Low Acceptance Rate 🔴',
  DEPOSIT:      '💵 Deposit',
  NEW:          'New ✨',
  LOYAL:        'Loyal 👑',
  BAD_ADDRESS:  'Address 🔺',
  CLEAR:        'Clear 👌🏻',
};

// ─────────────────────────────────────────────────────────────────────
//  2. VERCEL CONFIG — must disable body parser to verify HMAC
// ─────────────────────────────────────────────────────────────────────
async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Read raw body (needed before JSON.parse so HMAC works on original bytes)
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (err) {
    console.error('[webhook] Cannot read body:', err.message);
    return res.status(400).json({ error: 'Cannot read request body' });
  }

  // Verify Shopify HMAC signature — reject anything not from Shopify
  if (!verifyHmac(rawBody, req.headers['x-shopify-hmac-sha256'])) {
    console.warn('[webhook] HMAC mismatch — request rejected');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Parse JSON
  let order;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON payload' });
  }

  console.log(`\n[screening] ▶  Order ${order.name} received`);

  try {
    const applied = await screenOrder(order);
    console.log(`[screening] ✓  Order ${order.name} → [${applied.length ? applied.join(', ') : 'none'}]\n`);
    return res.status(200).json({ success: true, order: order.name, tagsApplied: applied });
  } catch (err) {
    console.error(`[screening] ✗  Order ${order.name} failed:`, err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

handler.config = { api: { bodyParser: false } };
module.exports = handler;

// ─────────────────────────────────────────────────────────────────────
//  3. MAIN SCREENING ENGINE
// ─────────────────────────────────────────────────────────────────────
async function screenOrder(order) {
  const existingTags = parseTagSet(order.tags);
  const toAdd        = [];

  // Helper: add tag only if not already on the order and not already queued
  const push = (tag) => {
    if (!existingTags.has(tag) && !toAdd.includes(tag)) {
      toAdd.push(tag);
    }
  };

  // Resolve order GID (used for the tagsAdd mutation later)
  const orderGid = order.admin_graphql_api_id
                || `gid://shopify/Order/${order.id}`;

  // Resolve phone from multiple possible fields
  const phone = firstTruthy(
    order.shipping_address?.phone,
    order.customer?.phone,
    order.billing_address?.phone
  );

  // ── CHECK 1 ─────────────────────────────────────────────────────
  //  Bosta acceptance rate (lookup by phone)
  // ────────────────────────────────────────────────────────────────
  if (phone) {
    const rate = await getBostaAcceptanceRate(phone);
    console.log(`[check1]  phone=${phone}  bosta_rate=${rate ?? 'unknown'}`);

    if (rate === 'Average') {
      push(TAG.AVG_RATE);
      push(TAG.CALL_CONFIRM);
    } else if (rate === 'Low') {
      push(TAG.LOW_RATE);
      push(TAG.DEPOSIT);       // Check 1 deposit
    }
    // rate === 'High' or null (new/unknown customer) → no action
  } else {
    console.log('[check1]  no phone found — skipping Bosta check');
  }

  // ── CHECK 2 ─────────────────────────────────────────────────────
  //  Order history via Shopify
  // ────────────────────────────────────────────────────────────────
  if (order.customer?.id) {
    const customerGid  = `gid://shopify/Customer/${order.customer.id}`;
    const allOrders    = await getCustomerOrders(customerGid);
    const prevOrders   = allOrders.filter(o => o.id !== orderGid);

    console.log(`[check2]  customer=${customerGid}  previous_orders=${prevOrders.length}`);

    if (prevOrders.length === 0) {
      // First order ever
      push(TAG.NEW);

    } else {
      // Any previously cancelled order?
      const hasCancelled = prevOrders.some(o => o.cancelledAt !== null);
      if (hasCancelled) {
        console.log('[check2]  cancelled order found → Deposit');
        push(TAG.DEPOSIT);     // push() is safe — will not duplicate if Check 1 already added it
      }

      // 2 or more previous orders AND all of them were paid → Loyal
      if (prevOrders.length >= 2 && prevOrders.every(o => o.displayFinancialStatus === 'PAID')) {
        console.log('[check2]  loyal customer detected');
        push(TAG.LOYAL);
      }
    }
  } else {
    // Guest checkout — no customer record
    console.log('[check2]  guest checkout — skipping order history check');
    push(TAG.NEW);   // treat guest as new
  }

  // ── CHECK 3 ─────────────────────────────────────────────────────
  //  Address completeness
  // ────────────────────────────────────────────────────────────────
  const addrResult = checkAddress(order.shipping_address);
  console.log(`[check3]  address_ok=${addrResult.ok}  reason=${addrResult.reason}`);

  if (!addrResult.ok) {
    push(TAG.BAD_ADDRESS);
  }

  // ── APPLY TAGS ───────────────────────────────────────────────────
  // If no alert tags were added → order is clear
  const alertTags = [TAG.AVG_RATE, TAG.CALL_CONFIRM, TAG.LOW_RATE, TAG.DEPOSIT, TAG.BAD_ADDRESS];
  const hasAlert  = toAdd.some(t => alertTags.includes(t)) ||
                    alertTags.some(t => existingTags.has(t));
  if (!hasAlert && !existingTags.has(TAG.CLEAR)) {
    push(TAG.CLEAR);
  }

  if (toAdd.length > 0) {
    await applyTags(orderGid, toAdd);
  }

  return toAdd;
}

// ─────────────────────────────────────────────────────────────────────
//  4. ADDRESS CHECK
//     Format A: governorate + city + zone* + building_number + street
//               (* zone required ONLY for Cairo / Giza)
//     Format B: governorate + city + compound_name + villa/unit_number
//     Special:  mention of  بيت  counts as building number
// ─────────────────────────────────────────────────────────────────────
function checkAddress(addr) {
  if (!addr) return fail('no address object');

  const { address1 = '', address2 = '', city = '', province = '' } = addr;

  if (!province || province.trim() === '')
    return fail('missing governorate (province)');
  if (!city || city.trim() === '')
    return fail('missing city');

  const combined = `${address1} ${address2}`;

  // ── Format B: compound + villa / unit ─────────────────────────
  const hasCompound = /compound|كمبوند|كومبوند|حي\s+\S|heights?|gardens?|village|residence|residences|زايد|zayed|مدينة|القطامية|الرحاب|مستقبل|سيتي|mayfair|سراي|الياسمين|النرجس|البنفسج|الزهور|الفل|القرنفل|بالم|بيراميدز|ميفير|ديار|سيليا|كناريا|دريم لاند|dreamland|التجمع|بيفرلي|beverly|وادي|الندى|الأندلس|ميدان|جرين|green|ليك|lake|ريفيرا|riviera|سنتر|center|بارك|park|مساكن/i
    .test(combined);
  const hasVillaOrUnit = /\bvilla\b|فيلا|ڤيلا|\bunit\b|وحدة|[0-9٠-٩]+/i.test(combined);

  // فيلا + رقم بدون كلمة كمبوند صريحة → Format B أيضاً
  const hasVillaWithNumber = /(?:فيلا|ڤيلا|\bvilla\b).*[0-9٠-٩]|[0-9٠-٩].*(?:فيلا|ڤيلا|\bvilla\b)/i.test(combined);

  if ((hasCompound && hasVillaOrUnit) || hasVillaWithNumber) return ok('Format B');

  // ── Format A ──────────────────────────────────────────────────
  // Building number: any Arabic/Western digit  OR  the word بيت
  const hasBuilding = /[0-9٠-٩]+/.test(combined) || /بيت|برج|عمارة|عمارات|عماره/.test(combined);
  if (!hasBuilding) return fail('missing building number');

  // Street
  const hasStreet = /شارع|street\b|st\b|طريق|road|كورنيش|مجاورة|حي\s|sector|block/i.test(combined);
  if (!hasStreet) return fail('missing street');

  // Zone: required only when province is Cairo/Giza AND city is generic (just "Cairo" or "Giza")
  // If city is a specific town/district (e.g. Badrashin, Sheikh Zayed, New Cairo), zone not needed
  const cairoOrGiza = /cairo|القاهر|giza|الجيز/i.test(province);
  const genericCity = /^(cairo|القاهرة|القاهره|giza|الجيزة|الجيزه|جيزة|جيزه)$/i.test(city.trim());
  if (cairoOrGiza && genericCity) {
    const hasZone =
      address2.trim().length > 0 ||
      /حي\s|منطقة|ناحية|district|zone|الدقي|المهندسين|مدينة نصر|عين شمس|هليوبوليس|مصر الجديدة|الزيتون|عباسية|فيصل|إمبابة|شبرا|المعادي|المقطم|التجمع|الشروق|بدر|العبور|الرحاب|مستقبل|القاهرة الجديدة|15 مايو|شرق|غرب|وسط|بحري|قبلي/i
        .test(combined);
    if (!hasZone) return fail('Cairo/Giza address is missing zone/district');
  }

  return ok('Format A');
}

const ok   = (reason) => ({ ok: true,  reason });
const fail = (reason) => ({ ok: false, reason });

// ─────────────────────────────────────────────────────────────────────
//  5. BOSTA API
//     ⚠️  Confirm exact endpoint + response field with Bosta support.
//         Adjust the two marked lines below once you have the docs.
// ─────────────────────────────────────────────────────────────────────
async function getBostaAcceptanceRate(phone) {
  if (!BOSTA_API_KEY) {
    console.warn('[bosta] BOSTA_API_KEY not set — skipping Check 1');
    return null;
  }

  try {
    // ▼ ADJUST this URL if Bosta gives you a different endpoint
    const url = `${BOSTA_API_BASE}/businesses/customers/acceptance-rate` +
                `?phone=${encodeURIComponent(phone)}`;

    const res = await fetchWithTimeout(url, {
      method:  'GET',
      headers: {
        Authorization:  `Bearer ${BOSTA_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }, 8000); // 8-second timeout

    if (res.status === 404) return null;  // customer not found in Bosta → skip

    if (!res.ok) {
      console.error(`[bosta] API returned ${res.status} for phone ${phone}`);
      return null;
    }

    const data = await res.json();

    // Log full response so we can see the actual field names
    console.log('[bosta] raw response:', JSON.stringify(data));

    // ▼ ADJUST this field name to match the actual Bosta response
    const rate = data.acceptanceRateLabel
              ?? data.acceptance_rate_label
              ?? data.acceptanceRate
              ?? data.acceptance_rate
              ?? data.rate
              ?? data.label
              ?? data.customerAcceptanceRate
              ?? data.customer_acceptance_rate
              ?? null;

    // Normalize to title-case in case Bosta returns lowercase
    if (typeof rate === 'string') {
      const normalized = rate.charAt(0).toUpperCase() + rate.slice(1).toLowerCase();
      return normalized; // "High" | "Average" | "Low"
    }

    return null;

  } catch (err) {
    console.error('[bosta] Request failed:', err.message);
    return null;   // network error → skip gracefully
  }
}

// ─────────────────────────────────────────────────────────────────────
//  6. SHOPIFY HELPERS
// ─────────────────────────────────────────────────────────────────────

/** Fetch all orders for a customer (up to 50) */
async function getCustomerOrders(customerGid) {
  const query = `
    query GetCustomerOrders($id: ID!) {
      customer(id: $id) {
        orders(first: 50, sortKey: CREATED_AT) {
          nodes {
            id
            cancelledAt
            displayFinancialStatus
          }
        }
      }
    }
  `;

  try {
    const result = await shopifyGQL(query, { id: customerGid });

    if (result.errors) {
      console.error('[shopify] getCustomerOrders errors:', result.errors);
      return [];
    }

    return result.data?.customer?.orders?.nodes ?? [];
  } catch (err) {
    console.error('[shopify] getCustomerOrders failed:', err.message);
    return [];
  }
}

/** Add tags to an order */
async function applyTags(orderGid, tags) {
  const mutation = `
    mutation ApplyTags($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        node {
          id
          ... on Order { name tags }
        }
        userErrors { field message }
      }
    }
  `;

  try {
    const result = await shopifyGQL(mutation, { id: orderGid, tags });

    if (result.errors) {
      console.error('[shopify] applyTags GraphQL errors:', result.errors);
      return;
    }

    const userErrors = result.data?.tagsAdd?.userErrors ?? [];
    if (userErrors.length > 0) {
      console.error('[shopify] applyTags userErrors:', JSON.stringify(userErrors));
    }
  } catch (err) {
    console.error('[shopify] applyTags failed:', err.message);
    throw err;   // re-throw so the main handler can return 500
  }
}

/** Generic Shopify Admin GraphQL call */
async function shopifyGQL(query, variables = {}) {
  const url = `https://${SHOPIFY_STORE}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetchWithTimeout(url, {
    method:  'POST',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  }, 10000); // 10-second timeout

  if (!res.ok) {
    throw new Error(`Shopify API returned HTTP ${res.status}`);
  }

  return res.json();
}

// ─────────────────────────────────────────────────────────────────────
//  7. UTILITIES
// ─────────────────────────────────────────────────────────────────────

/** Verify Shopify webhook HMAC signature */
function verifyHmac(rawBody, receivedHmac) {
  if (!receivedHmac || !SHOPIFY_WEBHOOK_SECRET) return false;
  const computed = crypto
    .createHmac('sha256', SHOPIFY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('base64');
  // Use timingSafeEqual to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(computed),
      Buffer.from(receivedHmac)
    );
  } catch {
    return false;
  }
}

/** Read the full raw body from a Node.js IncomingMessage stream */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    const onData  = (chunk) => chunks.push(chunk);
    const onEnd   = ()      => resolve(Buffer.concat(chunks));
    const onError = (err)   => reject(err);

    req.on('data',  onData);
    req.on('end',   onEnd);
    req.on('error', onError);
  });
}

/** fetch() with an abort timeout (Node 18+ has native fetch) */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Convert Shopify comma-separated tag string to a Set for O(1) lookups */
function parseTagSet(tagString) {
  if (!tagString) return new Set();
  return new Set(tagString.split(',').map((t) => t.trim()).filter(Boolean));
}

/** Return the first argument that is a non-empty string */
function firstTruthy(...values) {
  return values.find((v) => v && v.trim() !== '') ?? null;
}
