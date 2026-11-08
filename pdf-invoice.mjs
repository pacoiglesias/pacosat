const UUID = /\b[0-9A-F]{8}(?:\s*-\s*[0-9A-F]{4}){3}\s*-\s*[0-9A-F]{12}\b/gi;
const RFC = /(?<![A-Z0-9Ñ&])[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}(?![A-Z0-9Ñ&])/giu;

export function invoiceCandidates(text) {
  const unique = items => [...new Set(items)];
  return {
    uuids: unique(Array.from(text.matchAll(UUID), match => match[0].replace(/\s/g, '').toUpperCase())),
    rfcs: unique(Array.from(text.matchAll(RFC), match => match[0].toUpperCase())),
    hasText: Boolean(text.trim())
  };
}

export async function analyzeInvoicePdf(raw) {
  if (raw.length < 8 || raw.length > 15 * 1024 * 1024 || raw.subarray(0, 5).toString() !== '%PDF-') {
    throw Object.assign(new Error('Selecciona un PDF válido de hasta 15 MB.'), { status: 400 });
  }
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs').catch(() => {
    throw Object.assign(new Error('Falta el lector PDF. Vuelve a iniciar Faro con internet para instalarlo.'), { status: 503 });
  });
  const task = getDocument({ data: Uint8Array.from(raw), isEvalSupported: false,
    useSystemFonts: false, disableFontFace: true, enableXfa: false, stopAtErrors: true });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 35) throw new Error('El PDF supera las 35 páginas de análisis.');
    const pages = [];
    let length = 0;
    for (let i = 1; i <= pdf.numPages && length < 180000; i++) {
      const page = await pdf.getPage(i);
      const extracted = await page.getTextContent();
      const text = extracted.items.map(item => item.str || '').join(' ').slice(0, 180000 - length);
      length += text.length;
      pages.push(text);
      page.cleanup();
    }
    return { ...invoiceCandidates(pages.join('\n')), pages: pdf.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}
