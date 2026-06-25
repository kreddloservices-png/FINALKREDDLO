// netlify/functions/download-contract.js
//
// Streams a contract PDF directly to the browser without storing it anywhere.
// Fetches the contract doc from Firestore, passes all fields to
// generate-contract-pdf in preview mode, and pipes the bytes back as the
// HTTP response.
//
// GET /api/download-contract?contractId=xxx&idToken=yyy
//
// Security: idToken is a Firebase ID token, verified server-side, and its
//           decoded uid must match either freelancerUid or buyerUid on the
//           contract document.
//
//           FIX: this previously trusted a bare `uid` query-string value
//           with no verification that the actual requester controlled
//           that uid — anyone who knew (or could see, e.g. via another
//           API response) a contract's freelancerUid/buyerUid could
//           download that contract's signed PDF (names, signatures, deal
//           terms, IP addresses) by simply passing it as `uid`. This is
//           invoked via window.open() (a plain navigation), which can't
//           carry an Authorization header, so the caller's Firebase ID
//           token is passed as a query parameter instead and verified
//           the same way every other function verifies it from a header.
//
// Returns:
//   application/pdf binary stream (Content-Disposition: attachment)

const admin = require('firebase-admin');

function getAdmin() {
  if (admin.apps.length) return admin;
  const svc = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(svc) });
  return admin;
}

exports.handler = async (event) => {
  const { contractId, idToken } = event.queryStringParameters || {};

  if (!contractId || !idToken) {
    return { statusCode: 400, body: 'contractId and idToken are required' };
  }

  let uid;
  try {
    const decoded = await getAdmin().auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (err) {
    return { statusCode: 401, body: 'Invalid or expired session. Please refresh and try again.' };
  }

  try {
    const db = getAdmin().firestore();
    // Fix #9: use `projects` collection — this is where create-project.js writes.
    // The orphaned `contracts` collection was never populated by any create path.
    const snap = await db.collection('projects').doc(contractId).get();

    if (!snap.exists) {
      return { statusCode: 404, body: 'Contract not found' };
    }

    const data = snap.data();

    // Auth check: only freelancer or buyer may download
    if (data.freelancerUid !== uid && data.buyerUid !== uid) {
      return { statusCode: 403, body: 'Access denied' };
    }

    // If a stored PDF already exists, redirect to it — fastest path
    if (data.contractPdfUrl) {
      return {
        statusCode: 302,
        headers: { Location: data.contractPdfUrl },
        body: '',
      };
    }

    // Generate on-demand via the PDF handler
    const handler = require('./generate-contract-pdf');

    function toIso(ts) {
      if (!ts) return '';
      // Firestore Timestamp
      if (ts && typeof ts.toDate === 'function') return ts.toDate().toISOString();
      // ISO string stored directly (deadline is stored as string in projects)
      return String(ts);
    }

    const fakeEvent = {
      httpMethod: 'POST',
      body: JSON.stringify({
        projectId:           contractId,
        // projects store title in both `title` and `projectTitle`
        projectTitle:        data.title || data.projectTitle || 'Service Agreement',
        // projects store scope of work in `scope` (aliased from `description` in create-project.js)
        serviceDescription:  data.scope || data.description || '',
        // projects store budget in `amount` and `budget`
        budget:              data.amount || data.budget || 0,
        deadline:            toIso(data.deadline),
        freelancerName:      data.freelancerName      || '',
        freelancerUsername:  data.freelancerUsername  || '',
        freelancerSignature: data.freelancerSignature || '',
        freelancerSignedAt:  toIso(data.freelancerSignedAt),
        freelancerIp:        data.freelancerIp        || '',
        buyerName:           data.buyerName           || '',
        buyerEmail:          data.buyerEmail          || '',
        buyerSignature:      data.buyerSignature      || '',
        buyerSignedAt:       toIso(data.buyerSignedAt),
        buyerIp:             data.buyerIp             || '',
        agreementDate:       new Date().toLocaleDateString('en-US', {
                               month: 'long', day: 'numeric', year: 'numeric',
                             }),
        preview: true,
      }),
    };

    const result = await handler.handler(fakeEvent);

    if (result.statusCode !== 200) {
      return { statusCode: 500, body: 'PDF generation failed' };
    }

    // Pass through the binary PDF
    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="kreddlo-contract-${contractId}.pdf"`,
        'Cache-Control':       'private, no-store',
      },
      body:            result.body,          // already base64
      isBase64Encoded: result.isBase64Encoded,
    };

  } catch (err) {
    console.error('[download-contract]', err);
    return { statusCode: 500, body: err.message || 'Download failed' };
  }
};
