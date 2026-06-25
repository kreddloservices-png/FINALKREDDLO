/**
 * Netlify Function: removebg-process.js
 * Path: netlify/functions/removebg-process.js
 *
 * Accepts a base64-encoded image from the frontend, sends it to the
 * remove.bg API, and returns the background-removed image as base64.
 * Used during profile photo upload to give freelancers clean headshots.
 *
 * POST body:
 *   {
 *     imageBase64: string   — base64-encoded image (JPEG or PNG, no data: prefix)
 *     size?:       string   — output size: "auto" | "preview" | "full" (default: "auto")
 *   }
 *
 * Success response (200):
 *   { resultBase64: string }   — base64 PNG with background removed
 *
 * Error response (4xx / 5xx):
 *   { error: string }
 *
 * Environment variables required:
 *   REMOVEBG_API_KEY — API key from remove.bg account
 */

const REMOVEBG_API_URL = 'https://api.remove.bg/v1.0/removebg';

exports.handler = async (event) => {

  /* ── Accept POST only ── */
  if (event.httpMethod !== 'POST') {
    return respond(405, { error: 'Method not allowed.' });
  }

  /* ── Parse body ── */
  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'Invalid JSON body.' });
  }

  const { imageBase64, size = 'auto', mode = 'person' } = payload;

  if (!imageBase64 || typeof imageBase64 !== 'string' || imageBase64.trim() === '') {
    return respond(400, { error: 'imageBase64 is required.' });
  }

  /* ── Validate base64 length (remove.bg max: 12MB source) ── */
  const estimatedBytes = Math.ceil(imageBase64.length * 0.75);
  if (estimatedBytes > 12 * 1024 * 1024) {
    return respond(413, { error: 'Image is too large. Maximum source size is 12 MB.' });
  }

  /* ── Check env var ── */
  const apiKey = process.env.REMOVEBG_API_KEY;
  if (!apiKey) {
    console.error('REMOVEBG_API_KEY environment variable is not set.');
    return respond(500, { error: 'Background removal service is not configured.' });
  }

  /* ── Validate size param ── */
  const validSizes = ['auto', 'preview', 'small', 'regular', 'medium', 'hd', '4k', 'full'];
  const safeSize = validSizes.includes(size) ? size : 'auto';

  /* ── Build form data ── */
  // remove.bg accepts base64 via image_file_b64 form field
  const safeMode = mode === 'signature' ? 'other' : 'person';

  const formFields = {
    image_file_b64: imageBase64.trim(),
    size:           safeSize,
    type:           safeMode,       // 'person' for profile photos, 'other' for signatures
    format:         'png',          // always return PNG (supports transparency)
    bg_color:       '',             // transparent background
    add_shadow:     'false',
    semitransparency: mode === 'signature' ? 'false' : 'true', // hard edges for signatures, soft for photos
    channels:       'rgba',
  };

  // Encode as application/x-www-form-urlencoded
  const formBody = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  /* ── Call remove.bg API ── */
  let removeBgResponse;
  try {
    removeBgResponse = await fetch(REMOVEBG_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Api-Key':    apiKey,
      },
      body: formBody,
    });
  } catch (networkErr) {
    console.error('Network error reaching remove.bg:', networkErr.message);
    return respond(502, { error: 'Could not reach the background removal service. Please try again.' });
  }

  /* ── Handle response ── */
  if (!removeBgResponse.ok) {
    let errMessage = `Background removal service error (${removeBgResponse.status}).`;
    try {
      const errBody = await removeBgResponse.json();
      const detail  = errBody?.errors?.[0]?.title || errBody?.errors?.[0]?.detail || '';
      if (detail) errMessage = detail;
    } catch (_) { /* ignore parse error */ }

    // Log the status for debugging but return a clean message to the client
    console.error(`remove.bg API error — status: ${removeBgResponse.status}, message: ${errMessage}`);

    if (removeBgResponse.status === 402) {
      return respond(402, { error: 'Background removal credits are exhausted. Contact support.' });
    }
    if (removeBgResponse.status === 429) {
      return respond(429, { error: 'Rate limit reached. Please wait a moment and try again.' });
    }

    return respond(502, { error: errMessage });
  }

  /* ── Read the binary PNG response and convert to base64 ── */
  let resultBase64;
  try {
    const arrayBuffer = await removeBgResponse.arrayBuffer();
    resultBase64      = Buffer.from(arrayBuffer).toString('base64');
  } catch (err) {
    console.error('Failed to read remove.bg response body:', err.message);
    return respond(502, { error: 'Failed to process the background removal result.' });
  }

  if (!resultBase64) {
    console.error('remove.bg returned an empty response body.');
    return respond(502, { error: 'Background removal service returned an empty result.' });
  }

  console.log(`remove.bg success — size: ${safeSize}, outputBytes: ~${Math.round(resultBase64.length * 0.75 / 1024)}KB`);

  return respond(200, { resultBase64 });
};

/* ── Utility ── */
function respond(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': '*',
    },
    body: JSON.stringify(body),
  };
}
