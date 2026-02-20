import * as cheerio from 'cheerio';

// --- KODE SCRAPER MILIKMU ---
const generatorEmail = {
  api: {
    base: 'https://generator.email/',
    validate: 'check_adres_validation3.php'
  },
  h: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  },
  _f: async (u, o, r = 5) => {
    for (let i = 0, e; i < r; i++) {
      try { const res = await fetch(u, o); return o._t ? await res.text() : await res.json(); }
      catch (err) { e = err.message; if (i === r - 1) throw new Error(e); }
    }
  },
  _v: async function(u, d) {
    try {
      return await this._f(this.api.base + this.api.validate, {
        method: 'POST',
        headers: { ...this.h, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ usr: u, dmn: d })
      });
    } catch (e) { return { err: e.message }; }
  },
  _p: (e) => e?.includes('@') ? e.split('@') : null,

  generate: async function() {
    try {
      const $ = cheerio.load(await this._f(this.api.base, { headers: this.h, cache: 'no-store', _t: 1 }));
      const em = $('#email_ch_text').text();
      if (!em) return { success: false, result: 'Gagal generate email' };
      
      const [u, d] = this._p(em), v = await this._v(u, d);
      return { 
        success: true, 
        result: { 
          email: em, 
          emailStatus: v.status || null, 
          uptime: v.uptime || null, 
          ...(v.err && { error: v.err }) 
        } 
      };
    } catch (e) { return { success: false, result: e.message }; }
  },

  inbox: async function(em) {
    const p = this._p(em);
    if (!p) return { success: false, result: 'Email tidak boleh kosong' };
    
    const [u, d] = p, v = await this._v(u, d), ck = `surl=${d}/${u}`;
    let h;
    try { h = await this._f(this.api.base, { headers: { ...this.h, Cookie: ck }, cache: 'no-store', _t: 1 }); }
    catch (e) { return { success: true, result: { email: em, emailStatus: v.status, uptime: v.uptime, inbox: [], error: e.message } }; }

    if (h.includes('Email generator is ready')) return { success: true, result: { email: em, emailStatus: v.status, uptime: v.uptime, inbox: [] } };

    const $ = cheerio.load(h), c = parseInt($('#mess_number').text()) || 0, ib = [];
    
    if (c === 1) {
      const el = $('#email-table .e7m.row'), sp = el.find('.e7m.col-md-9 span');
      ib.push({ from: sp.eq(3).text().replace(/\(.*?\)/, '').trim(), to: sp.eq(1).text(), created: el.find('.e7m.tooltip').text().replace('Created: ', ''), subject: el.find('h1').text(), message: el.find('.e7m.mess_bodiyy').text().trim() });
    } else if (c > 1) {
      for (const l of $('#email-table a').map((_, a) => $(a).attr('href')).get()) {
        const m = cheerio.load(await this._f(this.api.base, { headers: { ...this.h, Cookie: `surl=${l.replace('/', '')}` }, cache: 'no-store', _t: 1 }));
        const sp = m('.e7m.col-md-9 span');
        ib.push({ from: sp.eq(3).text().replace(/\(.*?\)/, '').trim(), to: sp.eq(1).text(), created: m('.e7m.tooltip').text().replace('Created: ', ''), subject: m('h1').text(), message: m('.e7m.mess_bodiyy').text().trim() });
      }
    }
    return { success: true, result: { email: em, emailStatus: v.status, uptime: v.uptime, inbox: ib } };
  }
};
// --- END KODE SCRAPER ---

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  // Setup CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  const { action, email } = req.query;

  try {
    if (action === 'generate') {
      const data = await generatorEmail.generate();
      return res.status(200).json(data);
    } 
    else if (action === 'inbox' && email) {
      const data = await generatorEmail.inbox(email);
      return res.status(200).json(data);
    } 
    else {
      return res.status(400).json({ success: false, message: 'Invalid action or missing email' });
    }
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
