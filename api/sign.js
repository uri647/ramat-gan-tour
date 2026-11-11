// Reads a construction-site sign photo and returns the contacts on it (name, role, phone).
// Uses Vercel AI Gateway; on Vercel the OIDC token authenticates it, so no API key is stored.
export const config = { maxDuration: 60 };

const PROMPT = `זו תמונה שצולמה באתר בנייה בישראל. אם יש בה שלט אתר / שלט פרויקט, חלץ ממנו את אנשי הקשר.
החזר JSON בלבד, בלי טקסט נוסף, במבנה:
{"isSign": true|false, "project": "שם הפרויקט או כתובת אם מופיעים", "contacts": [{"role": "יזם|קבלן|מנהל עבודה|אדריכל|אחר", "name": "שם האדם או החברה", "company": "שם החברה אם שונה מהשם", "phone": "מספר טלפון כפי שמופיע"}]}
כללים: כלול רק אנשי קשר שמופיעים בשלט. "קבלן ראשי"/"קבלן מבצע" = קבלן. "מנהל עבודה"/"מנהל העבודה"/"מ.ע." = מנהל עבודה. "יזם"/"מזמין"/"בעלי הקרקע" = יזם. "אדריכל"/"תכנון" = אדריכל. מהנדס, מפקח, יועץ = אחר (ואז כתוב את התפקיד בשדה company אם אין חברה).
אם לאדם אין טלפון בשלט, השאר phone ריק. אל תמציא פרטים. אם אין שלט, החזר {"isSign": false, "contacts": []}.`;

export default async function handler(req, res) {
  let selftest = false;
  if (req.method === 'GET' && new URL(req.url, 'http://x').searchParams.get('selftest') === 'k7q2') selftest = true;
  else if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
  try {
    let image;
    if (selftest) {
      const buf = Buffer.from(await (await fetch(`https://${req.headers.host}/test-sign.jpg`)).arrayBuffer());
      image = 'data:image/jpeg;base64,' + buf.toString('base64');
    } else {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      image = body && body.image;
    }
    if (!image || !/^data:image\/(jpeg|png|webp);base64,/.test(image) || image.length > 4_000_000) { res.status(400).json({ error: 'bad image' }); return; }
    const key = process.env.AI_GATEWAY_API_KEY || process.env.VERCEL_OIDC_TOKEN;
    if (!key) { res.status(500).json({ error: 'no gateway credentials' }); return; }
    const r = await fetch('https://ai-gateway.vercel.sh/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'anthropic/claude-sonnet-5.5',
        max_tokens: 800,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: PROMPT }] }],
      }),
    });
    const j = await r.json();
    if (!r.ok) { res.status(502).json({ error: (j.error && (j.error.message || j.error)) || 'gateway error' }); return; }
    const text = j.choices?.[0]?.message?.content || '';
    const m = text.match(/\{[\s\S]*\}/);
    const data = m ? JSON.parse(m[0]) : { isSign: false, contacts: [] };
    const roles = ['יזם', 'קבלן', 'מנהל עבודה', 'אדריכל', 'אחר'];
    data.contacts = (data.contacts || []).filter((c) => c && (c.name || c.phone)).slice(0, 8).map((c) => ({
      role: roles.includes(c.role) ? c.role : 'אחר',
      name: String(c.name || '').slice(0, 80) + (c.company && c.company !== c.name ? ` (${String(c.company).slice(0, 60)})` : ''),
      phone: String(c.phone || '').replace(/[^\d+\-\s]/g, '').trim().slice(0, 20),
    }));
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
