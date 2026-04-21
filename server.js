// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const xml2js = require('xml2js');
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  AlignmentType, LevelFormat
} = require('docx');
const { buildBlogPrompt, buildTitlePrompt } = require('./prompts');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static('public'));

app.get('/', (req, res) => res.sendFile('index.html', { root: 'public' }));
app.get('/review/:token', (req, res) => res.sendFile('review.html', { root: 'public' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// ─── HEALTH ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// ─── CLIENTS ─────────────────────────────────────────────────────────────────

app.get('/api/clients', async (req, res) => {
  const { data, error } = await supabase.from('clients').select('id, name, vertical, wp_url, created_at').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients', async (req, res) => {
  const { name, vertical, wp_url, wp_username, wp_app_password } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const { data, error } = await supabase.from('clients').insert({ name, vertical, wp_url, wp_username, wp_app_password }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, vertical, wp_url, wp_username, wp_app_password } = req.body;
  const { data, error } = await supabase.from('clients').update({ name, vertical, wp_url, wp_username, wp_app_password }).eq('id', req.params.id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/clients/:id', async (req, res) => {
  const { error } = await supabase.from('clients').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── CLIENT PROFILE ───────────────────────────────────────────────────────────

app.get('/api/clients/:id/profile', async (req, res) => {
  const { data, error } = await supabase.from('client_profiles').select('*').eq('client_id', req.params.id).single();
  if (error && error.code !== 'PGRST116') return res.status(500).json({ error: error.message });
  res.json(data || null);
});

app.post('/api/clients/:id/profile', async (req, res) => {
  const { brand_voice, target_keywords, location, sitemap_pages } = req.body;
  const { data, error } = await supabase.from('client_profiles')
    .upsert({ client_id: req.params.id, brand_voice, target_keywords, location, sitemap_pages: sitemap_pages || [] }, { onConflict: 'client_id' })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── SITEMAP UPLOAD ───────────────────────────────────────────────────────────

app.post('/api/clients/:id/sitemap', upload.single('sitemap'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  let pages = [];
  const content = req.file.buffer.toString('utf-8');
  try {
    const result = await xml2js.parseStringPromise(content);
    const urls = result?.urlset?.url || [];
    pages = urls.map(u => ({ url: u.loc?.[0] || '', title: extractTitleFromUrl(u.loc?.[0] || '') })).filter(p => p.url);
  } catch {
    pages = content.split('\n').map(l => l.trim()).filter(l => l.startsWith('http')).map(url => ({ url, title: extractTitleFromUrl(url) }));
  }
  const { error } = await supabase.from('client_profiles').upsert({ client_id: req.params.id, sitemap_pages: pages }, { onConflict: 'client_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, count: pages.length, pages: pages.slice(0, 10) });
});

function extractTitleFromUrl(url) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  } catch { return url; }
}

// ─── BRAND RULES ─────────────────────────────────────────────────────────────

app.get('/api/clients/:id/rules', async (req, res) => {
  const { data, error } = await supabase.from('brand_rules').select('*').eq('client_id', req.params.id).order('created_at');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients/:id/rules', async (req, res) => {
  const { rule } = req.body;
  if (!rule) return res.status(400).json({ error: 'Rule text is required' });
  const { data, error } = await supabase.from('brand_rules').insert({ client_id: req.params.id, rule }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/clients/:id/rules/:ruleId', async (req, res) => {
  const { error } = await supabase.from('brand_rules').delete().eq('id', req.params.ruleId).eq('client_id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── TITLE GENERATION ─────────────────────────────────────────────────────────

app.post('/api/clients/:id/generate-titles', async (req, res) => {
  const { count = 12, topicDirection, targetKeywords } = req.body;
  const { data: profile } = await supabase.from('client_profiles').select('brand_voice, target_keywords, location, sitemap_pages').eq('client_id', req.params.id).single();
  const prompt = buildTitlePrompt({
    brandVoice: profile?.brand_voice,
    targetKeywords: targetKeywords || profile?.target_keywords,
    topicDirection,
    count: Math.min(Math.max(parseInt(count), 1), 50),
    sitemapReferences: profile?.sitemap_pages || [],
    location: profile?.location
  });
  try {
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
    const raw = message.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { titles: [] }; }
    const toInsert = (parsed.titles || []).map(t => ({ client_id: req.params.id, title: t.title, target_keyword: t.targetKeyword, rationale: t.rationale, status: 'proposed' }));
    if (toInsert.length > 0) await supabase.from('blog_titles').insert(toInsert);
    res.json({ titles: parsed.titles || [] });
  } catch (err) {
    console.error('Title generation error:', err);
    res.status(500).json({ error: 'Failed to generate titles' });
  }
});

// ─── BLOG TITLES CRUD ─────────────────────────────────────────────────────────

app.get('/api/clients/:id/titles', async (req, res) => {
  const { data, error } = await supabase.from('blog_titles').select('*').eq('client_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/titles/:titleId', async (req, res) => {
  const { title, target_keyword, status, notes } = req.body;
  const { data, error } = await supabase.from('blog_titles').update({ title, target_keyword, status, notes }).eq('id', req.params.titleId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/titles/:titleId', async (req, res) => {
  const { error } = await supabase.from('blog_titles').delete().eq('id', req.params.titleId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── SHAREABLE TITLE LINK (read-only) ────────────────────────────────────────

app.post('/api/clients/:id/share-titles', async (req, res) => {
  // Generate a simple token tied to the client ID — no DB storage needed for read-only
  const token = Buffer.from(`${req.params.id}:${process.env.SHARE_SECRET || 'mmw-share'}`).toString('base64url');
  const shareUrl = `${req.protocol}://${req.get('host')}/review/${token}`;
  const { data: titles } = await supabase.from('blog_titles').select('id').eq('client_id', req.params.id).eq('status', 'proposed');
  res.json({ shareUrl, count: titles?.length || 0 });
});

// Public: decode token and return read-only title list
app.get('/api/review/:token', async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.token, 'base64url').toString();
    const clientId = decoded.split(':')[0];
    if (!clientId) return res.status(404).json({ error: 'Invalid link' });

    const [titlesResult, clientResult] = await Promise.all([
      supabase.from('blog_titles').select('id, title, target_keyword, rationale').eq('client_id', clientId).eq('status', 'proposed').order('created_at'),
      supabase.from('clients').select('name, vertical').eq('id', clientId).single()
    ]);

    if (!titlesResult.data) return res.status(404).json({ error: 'No titles found' });
    res.json({ titles: titlesResult.data, clientName: clientResult.data?.name, vertical: clientResult.data?.vertical });
  } catch {
    res.status(404).json({ error: 'Invalid or expired link' });
  }
});

// ─── BLOG GENERATION ─────────────────────────────────────────────────────────

app.post('/api/generate-blog', async (req, res) => {
  const { clientId, titleId, title, targetKeyword, isOneOff = false } = req.body;
  if (!clientId || !title) return res.status(400).json({ error: 'clientId and title are required' });

  const [profileResult, rulesResult] = await Promise.all([
    supabase.from('client_profiles').select('brand_voice, sitemap_pages, location').eq('client_id', clientId).single(),
    supabase.from('brand_rules').select('rule').eq('client_id', clientId).order('created_at')
  ]);

  const profile = profileResult.data;
  const rules = (rulesResult.data || []).map(r => r.rule);

  const prompt = buildBlogPrompt({ title, targetKeyword, brandVoice: profile?.brand_voice, brandRules: rules, sitemapReferences: profile?.sitemap_pages || [], location: profile?.location });

  try {
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] });
    const rawContent = message.content[0].text;

    // Parse FAQ block
    let faqJson = null;
    const faqMatch = rawContent.match(/---FAQ---([\s\S]*?)---END FAQ---/);
    if (faqMatch) {
      const lines = faqMatch[1].trim().split('\n');
      const faqs = [];
      let currentQ = null;
      for (const line of lines) {
        const qm = line.match(/^Q:\s*(.+)/);
        const am = line.match(/^A:\s*(.+)/);
        if (qm) currentQ = qm[1].trim();
        else if (am && currentQ) { faqs.push({ question: currentQ, answer: am[1].trim() }); currentQ = null; }
      }
      if (faqs.length) faqJson = faqs;
    }

    // Parse schema block
    let schemaJson = null;
    const schemaMatch = rawContent.match(/---SCHEMA---([\s\S]*?)---END SCHEMA---/);
    if (schemaMatch) schemaJson = schemaMatch[1].trim();

    // Parse SEO metadata
    const metaMatch = rawContent.match(/---SEO METADATA---([\s\S]*?)---END METADATA---/);
    let metadata = {};
    if (metaMatch) {
      const mt = metaMatch[1];
      metadata.titleTag = (mt.match(/Title Tag:\s*(.+)/) || [])[1]?.trim();
      metadata.metaDescription = (mt.match(/Meta Description:\s*(.+)/) || [])[1]?.trim();
      metadata.slug = (mt.match(/Slug:\s*(.+)/) || [])[1]?.trim();
      metadata.targetKeyword = (mt.match(/Target Keyword:\s*(.+)/) || [])[1]?.trim();
      metadata.internalLinksUsed = (mt.match(/Internal Links Used:\s*([\s\S]+)/) || [])[1]?.trim();
    }

    const cleanContent = rawContent
      .replace(/---FAQ---[\s\S]*?---END FAQ---/, '')
      .replace(/---SEO METADATA---[\s\S]*?---END METADATA---/, '')
      .replace(/---SCHEMA---[\s\S]*?---END SCHEMA---/, '')
      .trim();

    const blogRecord = {
      client_id: clientId, title_id: titleId || null, title,
      target_keyword: targetKeyword || metadata.targetKeyword,
      content: cleanContent,
      title_tag: metadata.titleTag, meta_description: metadata.metaDescription,
      slug: metadata.slug, internal_links_used: metadata.internalLinksUsed,
      faq_json: faqJson, schema_json: schemaJson,
      status: 'draft', is_one_off: isOneOff
    };

    const { data: savedBlog, error: saveError } = await supabase.from('blogs').insert(blogRecord).select().single();
    if (saveError) { console.error('Supabase save error:', saveError); return res.json({ content: cleanContent, metadata, saved: false }); }

    if (titleId) await supabase.from('blog_titles').update({ status: 'in_progress' }).eq('id', titleId);

    res.json({ blog: savedBlog, metadata, saved: true });
  } catch (err) {
    console.error('Blog generation error:', err);
    res.status(500).json({ error: 'Failed to generate blog' });
  }
});

// ─── BLOGS CRUD ───────────────────────────────────────────────────────────────

app.get('/api/clients/:id/blogs', async (req, res) => {
  const { data, error } = await supabase.from('blogs').select('id, title, target_keyword, status, is_one_off, created_at, slug, wp_post_id').eq('client_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get('/api/blogs/:blogId', async (req, res) => {
  const { data, error } = await supabase.from('blogs').select('*').eq('id', req.params.blogId).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/blogs/:blogId/status', async (req, res) => {
  const { status } = req.body;
  const { data, error } = await supabase.from('blogs').update({ status }).eq('id', req.params.blogId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── DOCX EXPORT ─────────────────────────────────────────────────────────────

app.get('/api/blogs/:blogId/export', async (req, res) => {
  const { data: blog, error } = await supabase.from('blogs').select('*').eq('id', req.params.blogId).single();
  if (error) return res.status(500).json({ error: error.message });
  try {
    const buffer = await generateDocx(blog);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${blog.slug || slugify(blog.title)}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error('DOCX error:', err);
    res.status(500).json({ error: 'Failed to generate DOCX' });
  }
});

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

async function generateDocx(blog) {
  const lines = blog.content.split('\n');
  const children = [];

  for (const line of lines) {
    const t = line.trim();
    if (!t) { children.push(new Paragraph({ children: [new TextRun('')] })); continue; }
    if (t.startsWith('# ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t.slice(2), bold: true, size: 36, font: 'Poppins' })] }));
    } else if (t.startsWith('## ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t.slice(3), bold: true, size: 28, font: 'Poppins' })] }));
    } else if (t.startsWith('### ')) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t.slice(4), bold: true, size: 24, font: 'Poppins' })] }));
    } else if (t.startsWith('- ') || t.startsWith('* ')) {
      children.push(new Paragraph({ numbering: { reference: 'bullets', level: 0 }, children: [new TextRun({ text: t.slice(2), size: 22, font: 'Lato' })] }));
    } else if (t.startsWith('[Image:')) {
      children.push(new Paragraph({ children: [new TextRun({ text: t, italics: true, color: '888888', size: 20, font: 'Lato' })] }));
    } else {
      children.push(new Paragraph({ children: parseInlineFormatting(t) }));
    }
  }

  // FAQ section
  if (blog.faq_json && Array.isArray(blog.faq_json)) {
    children.push(new Paragraph({ children: [new TextRun('')] }));
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: 'Frequently Asked Questions', bold: true, size: 28, font: 'Poppins' })] }));
    for (const faq of blog.faq_json) {
      children.push(new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: faq.question, bold: true, size: 24, font: 'Poppins' })] }));
      children.push(new Paragraph({ children: [new TextRun({ text: faq.answer, size: 22, font: 'Lato' })] }));
      children.push(new Paragraph({ children: [new TextRun('')] }));
    }
  }

  // SEO metadata section
  if (blog.title_tag || blog.meta_description || blog.slug) {
    children.push(new Paragraph({ children: [new TextRun('')] }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'SEO Metadata', bold: true, size: 24, font: 'Poppins', color: '28AB83' })] }));
    for (const [label, value] of [['Title Tag', blog.title_tag], ['Meta Description', blog.meta_description], ['Slug', blog.slug], ['Target Keyword', blog.target_keyword], ['Internal Links', blog.internal_links_used]]) {
      if (value) children.push(new Paragraph({ children: [new TextRun({ text: `${label}: `, bold: true, size: 20, font: 'Lato' }), new TextRun({ text: value, size: 20, font: 'Lato' })] }));
    }
  }

  const doc = new Document({
    numbering: { config: [{ reference: 'bullets', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] }] },
    styles: {
      default: { document: { run: { font: 'Lato', size: 22 } } },
      paragraphStyles: [
        { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 36, bold: true, font: 'Poppins', color: '323547' }, paragraph: { spacing: { before: 360, after: 240 }, outlineLevel: 0 } },
        { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, font: 'Poppins', color: '323547' }, paragraph: { spacing: { before: 280, after: 160 }, outlineLevel: 1 } },
        { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: 'Poppins', color: '323547' }, paragraph: { spacing: { before: 200, after: 120 }, outlineLevel: 2 } }
      ]
    },
    sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children }]
  });

  return await Packer.toBuffer(doc);
}

function parseInlineFormatting(text) {
  const runs = [];
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (part.startsWith('**') && part.endsWith('**')) runs.push(new TextRun({ text: part.slice(2, -2), bold: true, size: 22, font: 'Lato' }));
    else if (part) runs.push(new TextRun({ text: part, size: 22, font: 'Lato' }));
  }
  return runs.length ? runs : [new TextRun({ text, size: 22, font: 'Lato' })];
}

// ─── WORDPRESS PUSH (as draft) ────────────────────────────────────────────────

app.post('/api/blogs/:blogId/push-to-wp', upload.single('featuredImage'), async (req, res) => {
  const { data: blog, error: blogError } = await supabase.from('blogs').select('*, clients(wp_url, wp_username, wp_app_password)').eq('id', req.params.blogId).single();
  if (blogError) return res.status(500).json({ error: blogError.message });

  const client = blog.clients;
  if (!client?.wp_url || !client?.wp_username || !client?.wp_app_password) return res.status(400).json({ error: 'WordPress credentials not configured for this client' });

  const wpUrl = client.wp_url.replace(/\/$/, '');
  const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');
  const authHeader = { 'Authorization': `Basic ${credentials}` };

  // Upload featured image if provided
  let featuredMediaId = null;
  if (req.file) {
    try {
      const imgRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Disposition': `attachment; filename="${req.file.originalname}"`,
          'Content-Type': req.file.mimetype,
        },
        body: req.file.buffer
      });
      if (imgRes.ok) {
        const imgData = await imgRes.json();
        featuredMediaId = imgData.id;
      }
    } catch (imgErr) {
      console.error('Featured image upload error:', imgErr);
      // Non-fatal — proceed without featured image
    }
  }

  const htmlContent = markdownToBasicHtml(blog.content);

  // Build FAQ HTML from structured data
  let faqHtml = '';
  if (blog.faq_json && Array.isArray(blog.faq_json)) {
    faqHtml = '\n<div class="faq-section">\n<h2>Frequently Asked Questions</h2>\n';
    for (const faq of blog.faq_json) {
      faqHtml += `<div class="faq-item">\n<h3>${faq.question}</h3>\n<p>${faq.answer}</p>\n</div>\n`;
    }
    faqHtml += '</div>\n';
  }

  // Append JSON-LD schema
  let schemaHtml = '';
  if (blog.schema_json) {
    schemaHtml = `\n<script type="application/ld+json">\n${blog.schema_json}\n</script>`;
  }

  const wpPayload = {
    title: blog.title_tag || blog.title,
    content: htmlContent + faqHtml + schemaHtml,
    status: 'draft',
    slug: blog.slug,
    excerpt: blog.meta_description,
    ...(featuredMediaId && { featured_media: featuredMediaId }),
    meta: { _yoast_wpseo_metadesc: blog.meta_description, _yoast_wpseo_focuskw: blog.target_keyword }
  };

  try {
    const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts`, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify(wpPayload)
    });
    if (!wpRes.ok) { const e = await wpRes.text(); return res.status(400).json({ error: `WordPress error: ${e}` }); }
    const wpPost = await wpRes.json();

    await supabase.from('blogs').update({ wp_post_id: wpPost.id, status: 'published' }).eq('id', req.params.blogId);

    res.json({ success: true, wpPostId: wpPost.id, wpEditUrl: `${wpUrl}/wp-admin/post.php?post=${wpPost.id}&action=edit` });
  } catch (err) {
    console.error('WP push error:', err);
    res.status(500).json({ error: 'Failed to push to WordPress' });
  }
});

// ─── WORDPRESS PUBLISH (change draft to live) ─────────────────────────────────

app.post('/api/blogs/:blogId/publish-wp', async (req, res) => {
  const { data: blog, error: blogError } = await supabase.from('blogs').select('wp_post_id, clients(wp_url, wp_username, wp_app_password)').eq('id', req.params.blogId).single();
  if (blogError) return res.status(500).json({ error: blogError.message });
  if (!blog.wp_post_id) return res.status(400).json({ error: 'This blog has not been pushed to WordPress yet' });

  const client = blog.clients;
  const wpUrl = client.wp_url.replace(/\/$/, '');
  const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');

  try {
    const wpRes = await fetch(`${wpUrl}/wp-json/wp/v2/posts/${blog.wp_post_id}`, {
      method: 'PUT',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'publish' })
    });
    if (!wpRes.ok) { const e = await wpRes.text(); return res.status(400).json({ error: `WordPress error: ${e}` }); }
    const wpPost = await wpRes.json();
    res.json({ success: true, url: wpPost.link });
  } catch (err) {
    res.status(500).json({ error: 'Failed to publish on WordPress' });
  }
});

// ─── TEST WP CONNECTION ───────────────────────────────────────────────────────

app.post('/api/clients/:id/test-wp', async (req, res) => {
  const { data: client } = await supabase.from('clients').select('wp_url, wp_username, wp_app_password').eq('id', req.params.id).single();
  if (!client?.wp_url) return res.status(400).json({ error: 'No WordPress URL configured' });
  try {
    const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');
    const testRes = await fetch(`${client.wp_url.replace(/\/$/, '')}/wp-json/wp/v2/users/me`, { headers: { 'Authorization': `Basic ${credentials}` } });
    if (testRes.ok) { const user = await testRes.json(); res.json({ success: true, message: `Connected as ${user.name}` }); }
    else res.json({ success: false, message: 'Authentication failed — check credentials' });
  } catch (err) {
    res.json({ success: false, message: `Connection failed: ${err.message}` });
  }
});

// ─── MARKDOWN TO HTML ─────────────────────────────────────────────────────────

function markdownToBasicHtml(markdown) {
  return markdown.split('\n').map(line => {
    const t = line.trim();
    if (!t) return '';
    if (t.startsWith('# ')) return `<h1>${t.slice(2)}</h1>`;
    if (t.startsWith('## ')) return `<h2>${t.slice(3)}</h2>`;
    if (t.startsWith('### ')) return `<h3>${t.slice(4)}</h3>`;
    if (t.startsWith('- ') || t.startsWith('* ')) return `<li>${t.slice(2)}</li>`;
    if (t.startsWith('[Image:')) return `<!-- ${t} -->`;
    return `<p>${t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</p>`;
  }).join('\n');
}

// ─── START ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MMW Blog Engine running on port ${PORT}`));
