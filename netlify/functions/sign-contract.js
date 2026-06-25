// netlify/functions/sign-contract.js
//
// Records a party's signature on a project in Firestore.
// Fix #9: Now reads/writes the `projects` collection (where create-project.js
// actually stores data) instead of the orphaned `contracts` collection.
// When both parties have signed, generates the PDF via generate-contract-pdf
// (internal call), uploads it to Cloudinary, and writes contractPdfUrl back
// to the Firestore document.
//
// POST body:
//   contractId   string   — Firestore projects doc ID
//   role         string   — 'freelancer' | 'buyer'
//   signature    string   — base64 PNG of signature (no data: prefix)
//   ip           string   — signer's IP (pass from client or from event headers)
//
// Returns:
//   { ok: true, bothSigned: bool, contractPdfUrl: string|null }

const admin      = require('firebase-admin');
const { verifyCaller } = require('./_verify-auth');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const fetch      = (...args) => import('node-fetch').then(m => m.default(...args));
const { createHash } = require('crypto');
const { sanitizeString } = require('./_sanitize');

// ── Firebase Admin (singleton) ────────────────────────────────────
function getAdmin() {
  if (admin.apps.length) return admin;
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin;
}

// ── Upload buffer to Cloudinary ───────────────────────────────────
async function uploadToCloudinary(pdfBuffer, publicId) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey    = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error('Cloudinary env vars not configured');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const folder    = 'kreddlo-contracts';
  const sigStr    = `folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret}`;
  const signature = createHash('sha1').update(sigStr).digest('hex');

  const formData  = new FormData();
  const blob      = new Blob([pdfBuffer], { type: 'application/pdf' });
  formData.append('file',      blob,       `${publicId}.pdf`);
  formData.append('public_id', publicId);
  formData.append('folder',    folder);
  formData.append('timestamp', timestamp);
  formData.append('api_key',   apiKey);
  formData.append('signature', signature);

  const res  = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/raw/upload`,
    { method: 'POST', body: formData }
  );
  const json = await res.json();

  if (!res.ok || json.error) {
    throw new Error(json.error?.message || 'Cloudinary upload failed');
  }

  // Return the secure_url (permanent, CDN-hosted)
  return json.secure_url;
}

// ── Generate PDF bytes by calling generate-contract-pdf internally ─
// We call the function's handler directly (same process) to avoid an
// extra HTTP round-trip. We require() the handler module directly.
async function buildPdf(contractData, contractId) {
  // Inline minimal PDF generation using the same logic as generate-contract-pdf
  // but only the fields we have. This avoids needing an HTTP call to itself.
  const handler = require('./generate-contract-pdf');

  const fakeEvent = {
    httpMethod: 'POST',
    body: JSON.stringify({
      projectId:           contractId,
      projectTitle:        contractData.title || contractData.projectTitle || 'Service Agreement',
      serviceDescription:  contractData.scope || contractData.description || '',
      budget:              contractData.amount || contractData.budget || 0,
      deadline:            contractData.deadline
                             ? (contractData.deadline.toDate
                                 ? contractData.deadline.toDate().toISOString()
                                 : contractData.deadline)
                             : '',
      freelancerName:      contractData.freelancerName   || '',
      freelancerUsername:  contractData.freelancerUsername || '',
      freelancerSignature: contractData.freelancerSignature || '',
      freelancerSignedAt:  contractData.freelancerSignedAt
                             ? (contractData.freelancerSignedAt.toDate
                                 ? contractData.freelancerSignedAt.toDate().toISOString()
                                 : contractData.freelancerSignedAt)
                             : '',
      freelancerIp:        contractData.freelancerIp     || '',
      buyerName:           contractData.buyerName        || '',
      buyerEmail:          contractData.buyerEmail       || '',
      buyerSignature:      contractData.buyerSignature   || '',
      buyerSignedAt:       contractData.buyerSignedAt
                             ? (contractData.buyerSignedAt.toDate
                                 ? contractData.buyerSignedAt.toDate().toISOString()
                                 : contractData.buyerSignedAt)
                             : '',
      buyerIp:             contractData.buyerIp          || '',
      agreementDate:       new Date().toLocaleDateString('en-US', {
                             month: 'long', day: 'numeric', year: 'numeric'
                           }),
      preview: true,
    }),
  };

  const result = await handler.handler(fakeEvent);

  if (result.statusCode !== 200) {
    throw new Error('PDF generation failed: ' + result.body);
  }

  // result.body is base64-encoded when isBase64Encoded=true
  return Buffer.from(result.body, 'base64');
}

// ── Internal function caller ──────────────────────────────────────
async function callFunction(name, payload) {
  const platformUrl = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
  if (!platformUrl) { console.warn(`PLATFORM_URL not set — cannot call ${name}.`); return; }
  try {
    const res = await fetch(`${platformUrl}/.netlify/functions/${name}`, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/json',
        'x-internal-secret': process.env.INTERNAL_FUNCTION_SECRET || '',
      },
      body:    JSON.stringify(payload),
    });
    if (!res.ok) console.warn(`${name} returned ${res.status}: ${await res.text()}`);
  } catch (err) {
    console.error(`Failed to call ${name}:`, err.message);
  }
}

// ── Main handler ──────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  /* ── Verify caller identity ── */
  const callerUid = await verifyCaller(event);
  if (!callerUid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in again.' }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { contractId, role, signature = '', ip = '' } = body;

  // Sanitize the signer's display name — it is embedded in the contract PDF
  // which is uploaded to Cloudinary and linked from the HTML dashboard pages.
  // signature is a base64 PNG blob — not a text field, not sanitized here.
  // ip is server-side-derived or discarded in favor of event headers below.

  if (!contractId || !role) {
    return { statusCode: 400, body: JSON.stringify({ error: 'contractId and role are required' }) };
  }
  if (role !== 'freelancer' && role !== 'buyer') {
    return { statusCode: 400, body: JSON.stringify({ error: 'role must be freelancer or buyer' }) };
  }

  try {
    const db  = getAdmin().firestore();
    // Fix #9: use `projects` collection — this is where create-project.js writes.
    // The orphaned `contracts` collection was never populated by any create path.
    const ref = db.collection('projects').doc(contractId);
    const snap = await ref.get();

    if (!snap.exists) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Contract not found' }) };
    }

    const data = snap.data();

    /* ── Ownership check (FIX) ──
       Previously `role` was trusted entirely from the request body, with
       no check that the verified caller actually corresponds to the
       contract's freelancerUid/buyerUid. That let any authenticated user
       sign someone else's contract by passing an arbitrary contractId and
       role. Mirrors the same ownership pattern already used in
       submit-delivery.js (project.freelancerUid !== freelancerUid) and
       raise-dispute.js (project.buyerUid === raisedBy). */
    const expectedUid = role === 'freelancer' ? data.freelancerUid : data.buyerUid;
    if (!expectedUid || expectedUid !== callerUid) {
      return {
        statusCode: 403,
        body: JSON.stringify({ error: 'You are not authorised to sign this contract as ' + role + '.' }),
      };
    }

    // Determine which fields to update
    const now = admin.firestore.FieldValue.serverTimestamp();
    const updates = {};

    if (role === 'freelancer') {
      /* KYC guard — freelancer must be verified to sign a contract */
      const freelancerUserSnap = await db.collection('users').doc(callerUid).get();
      if (!freelancerUserSnap.exists || freelancerUserSnap.data().kycStatus !== 'verified') {
        return {
          statusCode: 403,
          body: JSON.stringify({ error: 'Your identity must be verified before you can sign contracts.' }),
        };
      }

      if (data.freelancerSigned) {
        return {
          statusCode: 409,
          body: JSON.stringify({ error: 'Already signed as freelancer' }),
        };
      }
      updates.freelancerSigned    = true;
      updates.freelancerSignedAt  = now;
      updates.freelancerIp        = ip || (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
      if (signature) updates.freelancerSignature = signature;
    } else {
      if (data.buyerSigned) {
        return {
          statusCode: 409,
          body: JSON.stringify({ error: 'Already signed as buyer' }),
        };
      }
      updates.buyerSigned   = true;
      updates.buyerSignedAt = now;
      updates.buyerIp       = ip || (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || '';
      if (signature) updates.buyerSignature = signature;
    }

    // Write the signature fields first
    await ref.update(updates);

    // Check if both parties have now signed
    const freelancerSigned = role === 'freelancer' ? true : (data.freelancerSigned || false);
    const buyerSigned      = role === 'buyer'       ? true : (data.buyerSigned      || false);
    const bothSigned       = freelancerSigned && buyerSigned;

    let contractPdfUrl = data.contractPdfUrl || null;

    if (bothSigned && !contractPdfUrl) {
      // Re-fetch to get the server-written timestamps for the signature we just recorded
      const freshSnap = await ref.get();
      const freshData = freshSnap.data();

      // Merge in the new signature image so PDF has it
      if (role === 'freelancer' && signature) freshData.freelancerSignature = signature;
      if (role === 'buyer'      && signature) freshData.buyerSignature      = signature;

      // Generate PDF
      const pdfBuffer = await buildPdf(freshData, contractId);

      // Upload to Cloudinary
      const publicId  = `contract-${contractId}-${Date.now()}`;
      contractPdfUrl  = await uploadToCloudinary(pdfBuffer, publicId);

      // Persist URL + flip status to active + unlock payment button
      await ref.update({
        contractPdfUrl,
        status: 'active',
        escrowStatus: 'unfunded',
      });
    } else if (bothSigned && contractPdfUrl) {
      // Both were already signed before, just make sure status is active
      await ref.update({ status: 'active', escrowStatus: 'unfunded' });
    }

    /* ── Notify the other party ── */
    try {
      const platformUrl  = (process.env.PLATFORM_URL || 'https://kreddlo.space').replace(/\/$/, '');
      const contractUrl  = `${platformUrl}/dashboard-contracts.html`;
      const contractTitle = data.title || 'Contract';

      if (bothSigned) {
        // Both signed — notify both parties the contract is now active
        const notifyUids = [
          { uid: data.freelancerUid, name: data.buyerName     || 'the client',     other: data.freelancerName || 'the freelancer' },
          { uid: data.buyerUid,      name: data.freelancerName || 'the freelancer', other: data.buyerName      || 'the client' },
        ];
        for (const party of notifyUids) {
          if (!party.uid) continue;
          await callFunction('send-smart-notification', {
            userUid:    party.uid,
            title:      'Contract Now Active',
            body:       `"${contractTitle}" has been signed by both parties and is now active.`,
            url:        contractUrl,
            templateId: 'contract-active',
            emailMode:  'never',
            emailData:  { contractTitle, name: party.other },
          });
        }
      } else {
        // Only one party signed — notify the other to sign
        const otherUid  = role === 'freelancer' ? data.buyerUid      : data.freelancerUid;
        const signerName = role === 'freelancer' ? (data.freelancerName || 'The freelancer') : (data.buyerName || 'The client');
        if (otherUid) {
          await callFunction('send-smart-notification', {
            userUid:    otherUid,
            title:      'Signature Required',
            body:       `${signerName} has signed "${contractTitle}". Your signature is needed to activate it.`,
            url:        contractUrl,
            templateId: 'contract-sign-requested',
            emailMode:  'never',
            emailData:  { contractTitle, signerName },
          });
        }
      }
    } catch (notifErr) {
      // Non-fatal — contract is already signed/active
      console.warn('[sign-contract] notification error:', notifErr.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true, bothSigned, contractPdfUrl }),
    };

  } catch (err) {
    console.error('[sign-contract]', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'Signing failed' }),
    };
  }
};
