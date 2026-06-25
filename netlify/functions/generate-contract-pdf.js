// netlify/functions/generate-contract-pdf.js
//
// Generates a styled Kreddlo Service Agreement PDF with embedded
// signature images and returns the raw PDF bytes.
// Firebase Storage is NOT used here — upload is handled by sign-contract.js
// via Cloudinary when both parties have signed.
//
// POST body:
//   projectId            string   — Firestore project doc ID (used for naming only)
//   projectTitle         string
//   serviceDescription   string
//   budget               number   — service amount in USD
//   deadline             string   — ISO date string e.g. "2025-12-31"
//   freelancerName       string
//   freelancerUsername   string
//   freelancerSignature  string   — base64 PNG (no data: prefix)
//   freelancerSignedAt   string   — ISO datetime
//   freelancerIp         string
//   buyerName            string
//   buyerEmail           string
//   buyerSignature       string   — base64 PNG (no data: prefix)
//   buyerSignedAt        string   — ISO datetime
//   buyerIp              string
//   agreementDate        string   — human-readable e.g. "June 5, 2025"
//   preview              bool     — if true (default), return raw PDF binary
//
// Returns:
//   application/pdf binary (always)

const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');

// ── Colour helpers (pdf-lib uses 0-1 RGB) ────────────────────────
const NAVY  = rgb(0.051, 0.129, 0.271);   // #0d2145
const GREEN = rgb(0.176, 0.541, 0.369);   // #2d8a5e
const GREY  = rgb(0.392, 0.447, 0.545);   // #64748b
const WHITE = rgb(1, 1, 1);
const CREAM = rgb(0.973, 0.976, 0.984);   // #f8f9fb
const GREEN_BG = rgb(0.941, 0.980, 0.961); // #f0faf5
const GREEN_BORDER = rgb(0.784, 0.902, 0.831); // #c8e6d4
const SLATE_BG  = rgb(0.957, 0.961, 0.973); // #f4f6f9
const SLATE_BORDER = rgb(0.867, 0.890, 0.933); // #dde3ee
const LINE_COLOR   = rgb(0.886, 0.910, 0.941); // #e2e8f0

// ── Helpers ──────────────────────────────────────────────────────
function fmtMoney(n) {
  return '$' + Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtDate(d) {
  if (!d) return 'Not specified';
  try {
    // Handle both ISO datetime and plain date strings
    const dt = new Date(d.includes('T') ? d : d + 'T00:00:00');
    return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch { return d; }
}

function fmtDateTime(d) {
  if (!d) return 'Not specified';
  try {
    return new Date(d).toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    });
  } catch { return d; }
}

// Draw a filled rectangle
function rect(page, x, y, w, h, color) {
  page.drawRectangle({ x, y, width: w, height: h, color });
}

// Draw a rectangle outline
function rectStroke(page, x, y, w, h, color, thickness = 0.75) {
  page.drawRectangle({
    x, y, width: w, height: h,
    borderColor: color, borderWidth: thickness,
    opacity: 0,
  });
}

// Thin horizontal rule
function rule(page, x, y, w, color = LINE_COLOR) {
  page.drawLine({ start: { x, y }, end: { x: x + w, y }, color, thickness: 0.75 });
}

// Wrapped text — returns final y position after drawing
// pdf-lib doesn't wrap automatically so we do it manually
function drawWrapped(page, text, x, y, maxW, size, font, color) {
  const words  = String(text || '').split(' ');
  const lineH  = size * 1.5;
  let line     = '';
  let curY     = y;

  for (const word of words) {
    const test    = line ? line + ' ' + word : word;
    const testW   = font.widthOfTextAtSize(test, size);
    if (testW > maxW && line) {
      page.drawText(line, { x, y: curY, size, font, color });
      curY -= lineH;
      line  = word;
    } else {
      line = test;
    }
  }
  if (line) {
    page.drawText(line, { x, y: curY, size, font, color });
    curY -= lineH;
  }
  return curY; // y position after last line
}

// Small caps label
function label(page, text, x, y, font, size = 7) {
  page.drawText(text.toUpperCase(), { x, y, size, font, color: GREY, characterSpacing: 1.0 });
}

// ── Main handler ─────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const {
    projectId            = '',
    projectTitle         = 'Untitled Project',
    serviceDescription   = '',
    budget               = 0,
    deadline             = '',
    freelancerName       = '',
    freelancerUsername   = '',
    freelancerSignature  = '',   // base64 PNG
    freelancerSignedAt   = '',
    freelancerIp         = '',
    buyerName            = '',
    buyerEmail           = '',
    buyerSignature       = '',   // base64 PNG
    buyerSignedAt        = '',
    buyerIp              = '',
    agreementDate        = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }),
    preview              = true,  // always returns raw PDF now
  } = body;

  try {
    // ── Create document ──────────────────────────────────────────
    const pdfDoc = await PDFDocument.create();
    pdfDoc.setTitle(`Kreddlo Service Agreement — ${projectTitle}`);
    pdfDoc.setAuthor('Kreddlo Platform');
    pdfDoc.setCreationDate(new Date());

    // Embed fonts
    const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const bold    = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Embed signature images (if provided)
    let freelancerSigImg = null;
    let buyerSigImg      = null;

    if (freelancerSignature) {
      try {
        const sigBytes = Buffer.from(freelancerSignature, 'base64');
        freelancerSigImg = await pdfDoc.embedPng(sigBytes);
      } catch (_) { /* signature image invalid — skip, show text fallback */ }
    }

    if (buyerSignature) {
      try {
        const sigBytes = Buffer.from(buyerSignature, 'base64');
        buyerSigImg = await pdfDoc.embedPng(sigBytes);
      } catch (_) { /* skip */ }
    }

    // ── Page setup ───────────────────────────────────────────────
    // A4: 595 x 842 pt
    const PW = 595;
    const PH = 842;
    const ML = 52;   // left margin
    const MR = 52;   // right margin
    const CW = PW - ML - MR; // content width = 491

    const page = pdfDoc.addPage([PW, PH]);

    // ── HEADER BAR ───────────────────────────────────────────────
    rect(page, 0, PH - 88, PW, 88, NAVY);

    // Wordmark
    page.drawText('KREDDLO', {
      x: ML, y: PH - 44,
      size: 20, font: bold, color: WHITE,
    });
    // Divider pipe
    page.drawText('|', {
      x: ML + 94, y: PH - 44,
      size: 20, font: regular, color: rgb(1, 1, 1),
      opacity: 0.35,
    });
    // Document type
    page.drawText('SERVICE AGREEMENT', {
      x: ML + 108, y: PH - 44,
      size: 13, font: bold, color: GREEN,
      characterSpacing: 0.8,
    });

    // Agreement date line
    page.drawText(`Agreement Date: ${agreementDate}`, {
      x: ML, y: PH - 66,
      size: 8.5, font: regular, color: rgb(1, 1, 1),
      opacity: 0.6,
    });

    // Escrow badge (top right)
    rect(page, PW - MR - 110, PH - 60, 110, 22, rgb(0.176, 0.541, 0.369));
    page.drawText('ESCROW PROTECTED', {
      x: PW - MR - 100, y: PH - 52,
      size: 7, font: bold, color: WHITE, characterSpacing: 0.6,
    });

    // ── PARTIES ──────────────────────────────────────────────────
    let curY = PH - 110;

    label(page, 'Parties to this Agreement', ML, curY, bold);
    curY -= 14;

    const colW = (CW - 12) / 2;

    // Freelancer box
    const fBoxY = curY - 72;
    rect(page, ML, fBoxY, colW, 72, GREEN_BG);
    rectStroke(page, ML, fBoxY, colW, 72, GREEN_BORDER);
    label(page, 'Service Provider', ML + 10, fBoxY + 56, bold, 7);
    page.drawText(freelancerName || 'Not specified', {
      x: ML + 10, y: fBoxY + 40,
      size: 12, font: bold, color: NAVY,
    });
    if (freelancerUsername) {
      page.drawText('@' + freelancerUsername, {
        x: ML + 10, y: fBoxY + 24,
        size: 9, font: regular, color: GREY,
      });
    }

    // Buyer box
    const bBoxX = ML + colW + 12;
    rect(page, bBoxX, fBoxY, colW, 72, SLATE_BG);
    rectStroke(page, bBoxX, fBoxY, colW, 72, SLATE_BORDER);
    label(page, 'Client', bBoxX + 10, fBoxY + 56, bold, 7);
    page.drawText(buyerName || 'Not specified', {
      x: bBoxX + 10, y: fBoxY + 40,
      size: 12, font: bold, color: NAVY,
    });
    page.drawText(buyerEmail || '', {
      x: bBoxX + 10, y: fBoxY + 24,
      size: 9, font: regular, color: GREY,
    });

    curY = fBoxY - 18;
    rule(page, ML, curY, CW);
    curY -= 18;

    // ── PROJECT DETAILS ──────────────────────────────────────────
    label(page, 'Project Details', ML, curY, bold);
    curY -= 14;

    // Project title
    label(page, 'Project Title', ML, curY, regular);
    curY -= 12;
    page.drawText(projectTitle, { x: ML, y: curY, size: 12, font: bold, color: NAVY });
    curY -= 20;

    // Scope of work
    label(page, 'Scope of Work', ML, curY, regular);
    curY -= 12;
    curY = drawWrapped(page, serviceDescription || 'Not specified', ML, curY, CW, 10, regular, NAVY);
    curY -= 10;

    // Amount + Deadline row
    const halfW = (CW - 12) / 2;
    label(page, 'Agreed Amount', ML, curY, regular);
    label(page, 'Project Deadline', ML + halfW + 12, curY, regular);
    curY -= 14;
    page.drawText(fmtMoney(budget), {
      x: ML, y: curY,
      size: 18, font: bold, color: GREEN,
    });
    page.drawText(fmtDate(deadline), {
      x: ML + halfW + 12, y: curY,
      size: 12, font: bold, color: NAVY,
    });
    curY -= 24;

    rule(page, ML, curY, CW);
    curY -= 18;

    // ── TERMS AND CONDITIONS ─────────────────────────────────────
    label(page, 'Terms and Conditions', ML, curY, bold);
    curY -= 14;

    const clauses = [
      ['Payment Terms',
        'The agreed project amount is held in escrow by Kreddlo upon funding. Funds are released to the service provider only after the project is completed to the client\'s satisfaction and the client approves delivery. No funds are released without explicit client approval or a resolution ruling.'],
      ['Delivery',
        'The service provider agrees to deliver all work described in the Scope of Work section by the agreed deadline. Failure to deliver without prior written agreement to extend the deadline may result in escrow funds being returned to the client.'],
      ['Revisions',
        'Two rounds of reasonable revisions are included within the original project scope unless otherwise agreed in writing by both parties before work begins. Additional revision rounds beyond this limit may be subject to additional fees.'],
      ['Dispute Resolution',
        'Any disputes arising from this agreement are reviewed by the Kreddlo admin team based on this contract, submitted evidence, and project activity records. Both parties agree to submit evidence within five business days of a dispute being raised. The Kreddlo admin team\'s decision is final and binding.'],
      ['Confidentiality',
        'Both parties agree to keep all project details, communications, proprietary information, and deliverables confidential. Neither party may disclose the other\'s information to any third party without prior written consent, except as required by law.'],
    ];

    for (let i = 0; i < clauses.length; i++) {
      const [clauseTitle, clauseText] = clauses[i];

      // Number circle
      page.drawCircle({ x: ML + 7, y: curY + 4, size: 8, color: NAVY });
      page.drawText(String(i + 1), {
        x: ML + (i < 9 ? 4.5 : 2), y: curY,
        size: 7.5, font: bold, color: WHITE,
      });

      // Clause title
      page.drawText(clauseTitle, {
        x: ML + 22, y: curY,
        size: 10, font: bold, color: NAVY,
      });
      curY -= 14;

      // Clause body
      curY = drawWrapped(page, clauseText, ML + 22, curY, CW - 22, 9, regular, GREY);
      curY -= 10;
    }

    rule(page, ML, curY, CW);
    curY -= 18;

    // ── SIGNATURES ───────────────────────────────────────────────
    label(page, 'Signatures', ML, curY, bold);
    curY -= 14;

    // If signatures won't fit on this page, add a new page
    const sigBlockHeight = 120;
    let sigPage = page;
    let sigY    = curY;

    if (curY < 160) {
      sigPage = pdfDoc.addPage([PW, PH]);
      sigY    = PH - ML;
    }

    const sigColW = (CW - 12) / 2;

    // ── Freelancer signature block ────────────────────────────────
    const fSigX = ML;
    const fSigBoxY = sigY - sigBlockHeight;

    rect(sigPage, fSigX, fSigBoxY, sigColW, sigBlockHeight, CREAM);
    rectStroke(sigPage, fSigX, fSigBoxY, sigColW, sigBlockHeight, LINE_COLOR);

    label(sigPage, 'Service Provider Signature', fSigX + 10, sigY - 14, bold, 7);

    // Signature image or placeholder line
    if (freelancerSigImg) {
      const dims = freelancerSigImg.scale(0.0);
      const sigW = Math.min(sigColW - 20, 160);
      const sigH = Math.min(50, sigW * (freelancerSigImg.height / freelancerSigImg.width));
      sigPage.drawImage(freelancerSigImg, {
        x: fSigX + 10,
        y: sigY - 70,
        width: sigW,
        height: sigH,
      });
    } else {
      rule(sigPage, fSigX + 10, sigY - 50, sigColW - 20, NAVY);
      sigPage.drawText(freelancerName || '', {
        x: fSigX + 10, y: sigY - 64,
        size: 10, font: bold, color: NAVY,
      });
    }

    label(sigPage, `Signed: ${fmtDateTime(freelancerSignedAt) || 'Pending'}`,
      fSigX + 10, fSigBoxY + 28, regular, 7.5);
    label(sigPage, `IP: ${freelancerIp || 'Pending'}`,
      fSigX + 10, fSigBoxY + 14, regular, 7.5);

    // ── Buyer signature block ─────────────────────────────────────
    const bSigX = ML + sigColW + 12;

    rect(sigPage, bSigX, fSigBoxY, sigColW, sigBlockHeight, CREAM);
    rectStroke(sigPage, bSigX, fSigBoxY, sigColW, sigBlockHeight, LINE_COLOR);

    label(sigPage, 'Client Signature', bSigX + 10, sigY - 14, bold, 7);

    if (buyerSigImg) {
      const sigW = Math.min(sigColW - 20, 160);
      const sigH = Math.min(50, sigW * (buyerSigImg.height / buyerSigImg.width));
      sigPage.drawImage(buyerSigImg, {
        x: bSigX + 10,
        y: sigY - 70,
        width: sigW,
        height: sigH,
      });
    } else {
      rule(sigPage, bSigX + 10, sigY - 50, sigColW - 20, NAVY);
      sigPage.drawText(buyerName || '', {
        x: bSigX + 10, y: sigY - 64,
        size: 10, font: bold, color: NAVY,
      });
    }

    label(sigPage, `Signed: ${fmtDateTime(buyerSignedAt) || 'Pending'}`,
      bSigX + 10, fSigBoxY + 28, regular, 7.5);
    label(sigPage, `IP: ${buyerIp || 'Pending'}`,
      bSigX + 10, fSigBoxY + 14, regular, 7.5);

    // ── FOOTER STAMP ─────────────────────────────────────────────
    const footerY = fSigBoxY - 32;
    rect(sigPage, ML, footerY, CW, 40, GREEN_BG);
    rectStroke(sigPage, ML, footerY, CW, 40, GREEN_BORDER);

    sigPage.drawText('KREDDLO PLATFORM  ·  Escrow Protected  ·  Dispute Resolution Included', {
      x: ML + 12, y: footerY + 24,
      size: 7.5, font: bold, color: GREEN, characterSpacing: 0.4,
    });
    sigPage.drawText(
      'This document is generated by Kreddlo and is legally binding upon escrow funding and counter-signature by both parties.',
      { x: ML + 12, y: footerY + 10, size: 7.5, font: regular, color: GREY }
    );

    // ── PAGE NUMBERS ─────────────────────────────────────────────
    const pageCount = pdfDoc.getPageCount();
    for (let i = 0; i < pageCount; i++) {
      const pg = pdfDoc.getPage(i);
      pg.drawText(`Page ${i + 1} of ${pageCount}  —  Kreddlo Service Agreement`, {
        x: ML, y: 24,
        size: 7.5, font: regular, color: GREY,
      });
    }

    // ── Serialise ────────────────────────────────────────────────
    const pdfBytes = await pdfDoc.save();

    // Always return the raw PDF binary
    return {
      statusCode: 200,
      headers: {
        'Content-Type':        'application/pdf',
        'Content-Disposition': `attachment; filename="kreddlo-service-agreement.pdf"`,
        'Content-Length':      pdfBytes.length.toString(),
      },
      body:            Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true,
    };

  } catch (err) {
    console.error('generate-contract-pdf error:', err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message || 'PDF generation failed' }),
    };
  }
};
