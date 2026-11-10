// Serves a contact card from a real URL so iPhone Safari shows the native
// "Create New Contact" screen (a blob download from a home-screen app only shows a preview).
export default function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const clean = (v, max) => String(v || '').replace(/[\r\n]+/g, ' ').slice(0, max);
  const esc = (v) => v.replace(/([,;\\])/g, '\\$1');
  const name = clean(url.searchParams.get('name'), 80).trim() || 'איש קשר';
  const phone = clean(url.searchParams.get('phone'), 30).replace(/[^\d+]/g, '');
  const org = clean(url.searchParams.get('org'), 80).trim();
  const lines = [
    'BEGIN:VCARD', 'VERSION:3.0',
    // N = family;given — split so iPhone fills both name fields
    `N;CHARSET=UTF-8:${esc(name.split(/\s+/).slice(1).join(' '))};${esc(name.split(/\s+/)[0])};;;`,
    `FN;CHARSET=UTF-8:${esc(name)}`,
    org ? `ORG;CHARSET=UTF-8:${esc(org)}` : '',
    phone ? `TEL;TYPE=CELL:${phone}` : '',
    'END:VCARD', '',
  ].filter((l, i, a) => l !== '' || i === a.length - 1);
  res.setHeader('Content-Type', 'text/vcard; charset=utf-8');
  res.setHeader('Content-Disposition', `inline; filename="contact.vcf"; filename*=UTF-8''${encodeURIComponent(name)}.vcf`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(lines.join('\r\n'));
}
