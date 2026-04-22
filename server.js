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
const { buildBlogPrompt, buildTitlePrompt, buildTitleRewritePrompt, buildClusterPrompt } = require('./prompts');

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
  const { data, error } = await supabase.from('clients').select('id, name, vertical, wp_url, created_at, assigned_ae').order('name');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients', async (req, res) => {
  const { name, vertical, wp_url, wp_username, wp_app_password, assigned_ae } = req.body;
  if (!name) return res.status(400).json({ error: 'Client name is required' });
  const { data, error } = await supabase.from('clients').insert({ name, vertical, wp_url, wp_username, wp_app_password, assigned_ae }).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/clients/:id', async (req, res) => {
  const { name, vertical, wp_url, wp_username, wp_app_password, assigned_ae } = req.body;
  const updates = { name, vertical, wp_url, wp_username, assigned_ae };
  // Only overwrite the password if a new one was actually provided
  if (wp_app_password && wp_app_password.trim()) updates.wp_app_password = wp_app_password;
  const { data, error } = await supabase.from('clients').update(updates).eq('id', req.params.id).select().single();
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
  const { brand_voice, target_keywords, location, service_areas, sitemap_pages, blogs_per_month, schedule_start_date } = req.body;
  const { data, error } = await supabase.from('client_profiles')
    .upsert({
      client_id: req.params.id, brand_voice, target_keywords, location, service_areas,
      sitemap_pages: sitemap_pages || [],
      blogs_per_month: blogs_per_month ? parseInt(blogs_per_month) : 2,
      schedule_start_date: schedule_start_date || null
    }, { onConflict: 'client_id' })
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
  const { data: profile } = await supabase.from('client_profiles').select('brand_voice, target_keywords, location, service_areas, sitemap_pages, blogs_per_month, schedule_start_date').eq('client_id', req.params.id).single();

  const { data: existingTitles } = await supabase.from('blog_titles').select('scheduled_date').eq('client_id', req.params.id).in('status', ['proposed', 'approved', 'in_progress']).order('scheduled_date', { ascending: false });

  const blogsPerMonth = profile?.blogs_per_month || 2;
  const startDate = profile?.schedule_start_date ? new Date(profile.schedule_start_date) : new Date();

  let nextSlotDate = new Date(startDate);
  if (existingTitles && existingTitles.length > 0) {
    const lastDate = existingTitles.find(t => t.scheduled_date)?.scheduled_date;
    if (lastDate) nextSlotDate = new Date(lastDate);
  }

  const titleCount = Math.min(Math.max(parseInt(count), 1), 50);
  const prompt = buildTitlePrompt({
    brandVoice: profile?.brand_voice,
    targetKeywords: targetKeywords || profile?.target_keywords,
    topicDirection,
    count: titleCount,
    sitemapReferences: profile?.sitemap_pages || [],
    location: profile?.location,
    serviceAreas: profile?.service_areas
  });

  try {
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 4000, messages: [{ role: 'user', content: prompt }] });
    const raw = message.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { titles: [] }; }

    // Assign schedule slots to each generated title
    const toInsert = (parsed.titles || []).map((t, i) => {
      const slotDate = assignNextSlot(nextSlotDate, blogsPerMonth, existingTitles?.length || 0, i);
      const monthName = slotDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      const slotInMonth = getSlotInMonth(slotDate, blogsPerMonth, i);
      return {
        client_id: req.params.id,
        title: t.title,
        target_keyword: t.targetKeyword,
        rationale: t.rationale,
        status: 'proposed',
        scheduled_date: slotDate.toISOString().split('T')[0],
        schedule_slot: `${monthName} — Blog ${slotInMonth}`
      };
    });

    if (toInsert.length > 0) await supabase.from('blog_titles').insert(toInsert);
    res.json({ titles: parsed.titles || [], inserted: toInsert });
  } catch (err) {
    console.error('Title generation error:', err);
    res.status(500).json({ error: 'Failed to generate titles' });
  }
});

// Assign a publish date for a given slot index based on blogs_per_month
function assignNextSlot(baseDate, blogsPerMonth, existingCount, newIndex) {
  const totalSlot = existingCount + newIndex;
  const monthOffset = Math.floor(totalSlot / blogsPerMonth);
  const date = new Date(baseDate);
  date.setMonth(date.getMonth() + monthOffset);
  // Space blogs evenly within the month
  const slotInMonth = (totalSlot % blogsPerMonth);
  const spacingDays = Math.floor(28 / blogsPerMonth);
  date.setDate(1 + (slotInMonth * spacingDays));
  return date;
}

function getSlotInMonth(date, blogsPerMonth, index) {
  return (index % blogsPerMonth) + 1;
}

// ─── BLOG TITLES CRUD ─────────────────────────────────────────────────────────

app.get('/api/clients/:id/titles', async (req, res) => {
  const { data, error } = await supabase.from('blog_titles').select('*').eq('client_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/titles/:titleId', async (req, res) => {
  const { title, target_keyword, status, notes, scheduled_date, schedule_slot } = req.body;
  const updates = { title, target_keyword, status, notes };
  if (scheduled_date !== undefined) updates.scheduled_date = scheduled_date;
  if (schedule_slot !== undefined) updates.schedule_slot = schedule_slot;
  const { data, error } = await supabase.from('blog_titles').update(updates).eq('id', req.params.titleId).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.delete('/api/titles/:titleId', async (req, res) => {
  const { error } = await supabase.from('blog_titles').delete().eq('id', req.params.titleId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ─── CLIENT REVIEW RESPOND ────────────────────────────────────────────────────

// Client approves a title or submits a suggestion via the share link
app.post('/api/review/:token/respond', async (req, res) => {
  const { titleId, action, suggestion } = req.body;
  if (!['approved', 'suggestion', 'undo'].includes(action)) return res.status(400).json({ error: 'Invalid action' });

  try {
    const decoded = Buffer.from(req.params.token, 'base64url').toString();
    const clientId = decoded.split(':')[0];
    const { data: title } = await supabase.from('blog_titles').select('id, client_id').eq('id', titleId).eq('client_id', clientId).single();
    if (!title) return res.status(404).json({ error: 'Title not found' });

    let updates;
    if (action === 'approved') {
      updates = { client_approved: true, needs_review: false, client_suggestion: null };
    } else if (action === 'suggestion') {
      updates = { client_suggestion: suggestion, needs_review: true, client_approved: false };
    } else {
      updates = { client_approved: false, needs_review: false, client_suggestion: null };
    }

    const { error } = await supabase.from('blog_titles').update(updates).eq('id', titleId);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch {
    res.status(400).json({ error: 'Invalid token' });
  }
});

// ─── SHAREABLE TITLE LINK ─────────────────────────────────────────────────────

app.post('/api/clients/:id/share-titles', async (req, res) => {
  const token = Buffer.from(`${req.params.id}:${process.env.SHARE_SECRET || 'mmw-share'}`).toString('base64url');
  const shareUrl = `${req.protocol}://${req.get('host')}/review/${token}`;
  const { data: titles } = await supabase.from('blog_titles').select('id').eq('client_id', req.params.id).eq('status', 'proposed');
  res.json({ shareUrl, count: titles?.length || 0 });
});

// Public: decode token and return title list with client response state
app.get('/api/review/:token', async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.token, 'base64url').toString();
    const clientId = decoded.split(':')[0];
    if (!clientId) return res.status(404).json({ error: 'Invalid link' });

    const [titlesResult, clientResult] = await Promise.all([
      supabase.from('blog_titles')
        .select('id, title, target_keyword, rationale, schedule_slot, scheduled_date, client_approved, client_suggestion, needs_review')
        .eq('client_id', clientId)
        .eq('status', 'proposed')
        .order('scheduled_date', { ascending: true }),
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
  const { clientId, titleId, title, targetKeyword, isOneOff = false, scheduledDate } = req.body;
  if (!clientId || !title) return res.status(400).json({ error: 'clientId and title are required' });

  const [profileResult, rulesResult] = await Promise.all([
    supabase.from('client_profiles').select('brand_voice, sitemap_pages, location, service_areas').eq('client_id', clientId).single(),
    supabase.from('brand_rules').select('rule').eq('client_id', clientId).order('created_at')
  ]);

  const profile = profileResult.data;
  const rules = (rulesResult.data || []).map(r => r.rule);

  // Load cluster context if this title belongs to a cluster
  let clusterContext = null;
  if (titleId) {
    const { data: titleData } = await supabase.from('blog_titles').select('cluster_id').eq('id', titleId).single();
    if (titleData?.cluster_id) {
      const { data: cluster } = await supabase.from('clusters').select('pillar_topic, pillar_keyword').eq('id', titleData.cluster_id).single();
      if (cluster) clusterContext = { pillarTopic: cluster.pillar_topic, pillarKeyword: cluster.pillar_keyword };
    }
  }

  const prompt = buildBlogPrompt({
    title, targetKeyword,
    brandVoice: profile?.brand_voice,
    brandRules: rules,
    sitemapReferences: profile?.sitemap_pages || [],
    location: profile?.location,
    serviceAreas: profile?.service_areas,
    clusterContext
  });

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
      metadata.wordCount = (mt.match(/Word Count:\s*(\d+)/) || [])[1]?.trim();
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
      word_count: metadata.wordCount ? parseInt(metadata.wordCount) : null,
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

// ─── AI TITLE REWRITE FROM CLIENT FEEDBACK ───────────────────────────────────

app.post('/api/titles/:titleId/rewrite', async (req, res) => {
  const { data: title, error: titleErr } = await supabase
    .from('blog_titles')
    .select('title, target_keyword, client_suggestion, client_id')
    .eq('id', req.params.titleId)
    .single();

  if (titleErr || !title) return res.status(404).json({ error: 'Title not found' });
  if (!title.client_suggestion) return res.status(400).json({ error: 'No client suggestion on this title' });

  const [profileResult] = await Promise.all([
    supabase.from('client_profiles').select('brand_voice, target_keywords, location, sitemap_pages').eq('client_id', title.client_id).single()
  ]);
  const profile = profileResult.data;

  const prompt = buildTitleRewritePrompt({
    originalTitle: title.title,
    originalKeyword: title.target_keyword,
    clientNote: title.client_suggestion,
    brandVoice: profile?.brand_voice,
    targetKeywords: profile?.target_keywords,
    location: profile?.location,
    sitemapReferences: profile?.sitemap_pages || []
  });

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = message.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : { alternatives: [] }; }
    res.json({ alternatives: parsed.alternatives || [] });
  } catch (err) {
    console.error('Title rewrite error:', err);
    res.status(500).json({ error: 'Failed to generate alternatives' });
  }
});

// Accept one of the AI alternatives — replaces the title and clears the suggestion flag
app.post('/api/titles/:titleId/accept-rewrite', async (req, res) => {
  const { title, targetKeyword } = req.body;
  if (!title) return res.status(400).json({ error: 'Title is required' });
  const { data, error } = await supabase
    .from('blog_titles')
    .update({ title, target_keyword: targetKeyword, client_suggestion: null, needs_review: false, client_approved: false })
    .eq('id', req.params.titleId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── WP CATEGORIES ───────────────────────────────────────────────────────────

app.get('/api/clients/:id/wp-categories', async (req, res) => {
  const { data: client } = await supabase.from('clients').select('wp_url, wp_username, wp_app_password').eq('id', req.params.id).single();
  if (!client?.wp_url) return res.status(400).json({ error: 'No WordPress URL configured' });
  try {
    const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');
    const wpRes = await fetch(`${client.wp_url.replace(/\/$/, '')}/wp-json/wp/v2/categories?per_page=100`, { headers: { 'Authorization': `Basic ${credentials}` } });
    if (!wpRes.ok) return res.status(400).json({ error: 'Failed to fetch categories from WordPress' });
    const cats = await wpRes.json();
    const simplified = cats.map(c => ({ id: c.id, name: c.name, slug: c.slug, count: c.count }));
    await supabase.from('client_profiles').upsert({ client_id: req.params.id, wp_categories: simplified }, { onConflict: 'client_id' });
    res.json(simplified);
  } catch (err) { res.status(500).json({ error: `Connection failed: ${err.message}` }); }
});

app.post('/api/clients/:id/wp-categories', async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Category name is required' });
  const { data: client } = await supabase.from('clients').select('wp_url, wp_username, wp_app_password').eq('id', req.params.id).single();
  if (!client?.wp_url) return res.status(400).json({ error: 'No WordPress URL configured' });
  try {
    const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');
    const wpRes = await fetch(`${client.wp_url.replace(/\/$/, '')}/wp-json/wp/v2/categories`, {
      method: 'POST',
      headers: { 'Authorization': `Basic ${credentials}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    if (!wpRes.ok) { const e = await wpRes.json(); return res.status(400).json({ error: e.message || 'Failed to create category' }); }
    const cat = await wpRes.json();
    const { data: profile } = await supabase.from('client_profiles').select('wp_categories').eq('client_id', req.params.id).single();
    const updated = [...(profile?.wp_categories || []), { id: cat.id, name: cat.name, slug: cat.slug, count: 0 }];
    await supabase.from('client_profiles').upsert({ client_id: req.params.id, wp_categories: updated }, { onConflict: 'client_id' });
    res.json({ id: cat.id, name: cat.name, slug: cat.slug });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── DASHBOARD STATS ─────────────────────────────────────────────────────────

app.get('/api/dashboard-stats', async (req, res) => {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const thirtyDaysAgo = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [allBlogs, monthBlogs, thirtyBlogs, pendingBlogs, recentActivity, totalClients] = await Promise.all([
    supabase.from('blogs').select('id', { count: 'exact', head: true }),
    supabase.from('blogs').select('id', { count: 'exact', head: true }).eq('status', 'published').gte('created_at', startOfMonth),
    supabase.from('blogs').select('id', { count: 'exact', head: true }).gte('created_at', thirtyDaysAgo),
    supabase.from('blogs').select('id', { count: 'exact', head: true }).eq('status', 'in-review'),
    supabase.from('blog_titles').select('id, title, client_id, client_approved, needs_review, updated_at, clients(name)').or('client_approved.eq.true,needs_review.eq.true').gte('updated_at', sevenDaysAgo).order('updated_at', { ascending: false }).limit(15),
    supabase.from('clients').select('id', { count: 'exact', head: true })
  ]);

  res.json({
    totalClients: totalClients.count || 0,
    totalBlogs: allBlogs.count || 0,
    blogsThisMonth: monthBlogs.count || 0,
    blogsLast30Days: thirtyBlogs.count || 0,
    pendingApproval: pendingBlogs.count || 0,
    recentActivity: recentActivity.data || []
  });
});

// ─── TOPIC CLUSTERS ───────────────────────────────────────────────────────────

app.get('/api/clients/:id/clusters', async (req, res) => {
  const { data, error } = await supabase.from('clusters').select('*, blog_titles(id, title, status, schedule_slot)').eq('client_id', req.params.id).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.post('/api/clients/:id/generate-cluster', async (req, res) => {
  const { pillarTopic, supportingCount = 5 } = req.body;
  if (!pillarTopic) return res.status(400).json({ error: 'Pillar topic is required' });

  const [profileResult, existingTitlesResult] = await Promise.all([
    supabase.from('client_profiles').select('brand_voice, target_keywords, location, service_areas, sitemap_pages, blogs_per_month, schedule_start_date').eq('client_id', req.params.id).single(),
    supabase.from('blog_titles').select('scheduled_date').eq('client_id', req.params.id).in('status', ['proposed', 'approved', 'in_progress']).order('scheduled_date', { ascending: false })
  ]);
  const profile = profileResult.data;
  const existingTitles = existingTitlesResult.data || [];

  const prompt = buildClusterPrompt({
    pillarTopic, brandVoice: profile?.brand_voice, targetKeywords: profile?.target_keywords,
    location: profile?.location, serviceAreas: profile?.service_areas,
    sitemapReferences: profile?.sitemap_pages || [],
    count: Math.min(Math.max(parseInt(supportingCount), 3), 8)
  });

  try {
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 3000, messages: [{ role: 'user', content: prompt }] });
    const raw = message.content[0].text.trim();
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { const m = raw.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
    if (!parsed) return res.status(500).json({ error: 'Failed to parse cluster response' });

    const { data: cluster, error: clusterErr } = await supabase.from('clusters').insert({
      client_id: req.params.id, pillar_topic: pillarTopic,
      pillar_keyword: parsed.pillar?.targetKeyword, pillar_brief: JSON.stringify(parsed.pillar)
    }).select().single();
    if (clusterErr) return res.status(500).json({ error: clusterErr.message });

    const blogsPerMonth = profile?.blogs_per_month || 2;
    const startDate = profile?.schedule_start_date ? new Date(profile.schedule_start_date) : new Date();
    let nextSlotDate = new Date(startDate);
    if (existingTitles.length > 0) {
      const lastDate = existingTitles.find(t => t.scheduled_date)?.scheduled_date;
      if (lastDate) nextSlotDate = new Date(lastDate);
    }

    const toInsert = (parsed.supportingTitles || []).map((t, i) => {
      const slotDate = assignNextSlot(nextSlotDate, blogsPerMonth, existingTitles.length, i);
      const monthName = slotDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });
      return {
        client_id: req.params.id, cluster_id: cluster.id, cluster_position: i + 1,
        title: t.title, target_keyword: t.targetKeyword, rationale: t.rationale, status: 'proposed',
        scheduled_date: slotDate.toISOString().split('T')[0],
        schedule_slot: `${monthName} — Blog ${(existingTitles.length + i) % blogsPerMonth + 1}`
      };
    });

    if (toInsert.length > 0) await supabase.from('blog_titles').insert(toInsert);
    res.json({ cluster, pillar: parsed.pillar, supportingTitles: parsed.supportingTitles });
  } catch (err) {
    console.error('Cluster generation error:', err);
    res.status(500).json({ error: 'Failed to generate cluster' });
  }
});

// ─── BLOG PREVIEW LINK (client-facing) ───────────────────────────────────────

app.post('/api/blogs/:blogId/share', async (req, res) => {
  const token = Buffer.from(`${req.params.blogId}:${process.env.SHARE_SECRET || 'mmw-share'}`).toString('base64url');
  const shareUrl = `${req.protocol}://${req.get('host')}/blog-preview/${token}`;
  res.json({ shareUrl });
});

app.get('/api/blog-preview/:token', async (req, res) => {
  try {
    const decoded = Buffer.from(req.params.token, 'base64url').toString();
    const blogId = decoded.split(':')[0];
    const { data: blog, error } = await supabase.from('blogs').select('title, content, title_tag, meta_description, slug, target_keyword, word_count, faq_json, created_at').eq('id', blogId).single();
    if (error || !blog) return res.status(404).json({ error: 'Blog not found' });
    res.json(blog);
  } catch { res.status(404).json({ error: 'Invalid or expired link' }); }
});

app.get('/blog-preview/:token', (req, res) => res.sendFile('blog-preview.html', { root: 'public' }));

// Returns status of a batch job stored in-memory (sufficient for single-server Render deploy)
const batchJobs = {};

app.post('/api/clients/:id/batch-generate', async (req, res) => {
  const { titleIds } = req.body;
  if (!titleIds || !titleIds.length) return res.status(400).json({ error: 'No title IDs provided' });

  const jobId = `${req.params.id}_${Date.now()}`;
  batchJobs[jobId] = { total: titleIds.length, completed: 0, failed: 0, results: [], status: 'running' };

  // Respond immediately so the UI doesn't wait
  res.json({ jobId, total: titleIds.length });

  // Run sequentially in the background
  (async () => {
    const [profileResult, rulesResult] = await Promise.all([
      supabase.from('client_profiles').select('brand_voice, sitemap_pages, location, service_areas').eq('client_id', req.params.id).single(),
      supabase.from('brand_rules').select('rule').eq('client_id', req.params.id).order('created_at')
    ]);
    const profile = profileResult.data;
    const rules = (rulesResult.data || []).map(r => r.rule);

    for (const titleId of titleIds) {
      try {
        const { data: titleData } = await supabase.from('blog_titles').select('title, target_keyword, cluster_id').eq('id', titleId).single();
        if (!titleData) { batchJobs[jobId].failed++; continue; }

        let clusterContext = null;
        if (titleData.cluster_id) {
          const { data: cluster } = await supabase.from('clusters').select('pillar_topic, pillar_keyword').eq('id', titleData.cluster_id).single();
          if (cluster) clusterContext = { pillarTopic: cluster.pillar_topic, pillarKeyword: cluster.pillar_keyword };
        }

        const prompt = buildBlogPrompt({
          title: titleData.title, targetKeyword: titleData.target_keyword,
          brandVoice: profile?.brand_voice, brandRules: rules,
          sitemapReferences: profile?.sitemap_pages || [],
          location: profile?.location, serviceAreas: profile?.service_areas,
          clusterContext
        });

        const message = await anthropic.messages.create({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages: [{ role: 'user', content: prompt }] });
        const rawContent = message.content[0].text;

        let faqJson = null;
        const faqMatch = rawContent.match(/---FAQ---([\s\S]*?)---END FAQ---/);
        if (faqMatch) {
          const lines = faqMatch[1].trim().split('\n');
          const faqs = []; let currentQ = null;
          for (const line of lines) {
            const qm = line.match(/^Q:\s*(.+)/), am = line.match(/^A:\s*(.+)/);
            if (qm) currentQ = qm[1].trim();
            else if (am && currentQ) { faqs.push({ question: currentQ, answer: am[1].trim() }); currentQ = null; }
          }
          if (faqs.length) faqJson = faqs;
        }

        let schemaJson = null;
        const schemaMatch = rawContent.match(/---SCHEMA---([\s\S]*?)---END SCHEMA---/);
        if (schemaMatch) schemaJson = schemaMatch[1].trim();

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

        const { data: savedBlog } = await supabase.from('blogs').insert({
          client_id: req.params.id, title_id: titleId, title: titleData.title,
          target_keyword: titleData.target_keyword || metadata.targetKeyword,
          content: cleanContent, title_tag: metadata.titleTag,
          meta_description: metadata.metaDescription, slug: metadata.slug,
          internal_links_used: metadata.internalLinksUsed,
          faq_json: faqJson, schema_json: schemaJson,
          status: 'draft', is_one_off: false
        }).select().single();

        await supabase.from('blog_titles').update({ status: 'in_progress' }).eq('id', titleId);
        batchJobs[jobId].completed++;
        batchJobs[jobId].results.push({ titleId, blogId: savedBlog?.id, title: titleData.title });
      } catch (err) {
        console.error(`Batch generation error for title ${titleId}:`, err);
        batchJobs[jobId].failed++;
      }
    }
    batchJobs[jobId].status = 'done';
    // Clean up after 1 hour
    setTimeout(() => { delete batchJobs[jobId]; }, 3600000);
  })();
});

app.get('/api/batch-status/:jobId', (req, res) => {
  const job = batchJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── BLOGS CRUD ───────────────────────────────────────────────────────────────

app.get('/api/clients/:id/blogs', async (req, res) => {
  const { data, error } = await supabase.from('blogs').select('id, title, target_keyword, status, is_one_off, created_at, slug, wp_post_id, word_count').eq('client_id', req.params.id).order('created_at', { ascending: false });
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

app.post('/api/blogs/:blogId/push-to-wp', upload.fields([{ name: 'featuredImage', maxCount: 1 }]), async (req, res) => {
  const { data: blog, error: blogError } = await supabase.from('blogs').select('*, clients(wp_url, wp_username, wp_app_password)').eq('id', req.params.blogId).single();
  if (blogError) return res.status(500).json({ error: blogError.message });

  const client = blog.clients;
  if (!client?.wp_url || !client?.wp_username || !client?.wp_app_password) return res.status(400).json({ error: 'WordPress credentials not configured for this client' });

  const wpUrl = client.wp_url.replace(/\/$/, '');
  const credentials = Buffer.from(`${client.wp_username}:${client.wp_app_password}`).toString('base64');
  const authHeader = { 'Authorization': `Basic ${credentials}` };

  // Upload featured image if provided
  let featuredMediaId = null;
  const imageFile = req.files?.featuredImage?.[0];
  if (imageFile) {
    try {
      const imgRes = await fetch(`${wpUrl}/wp-json/wp/v2/media`, {
        method: 'POST',
        headers: {
          ...authHeader,
          'Content-Disposition': `attachment; filename="${imageFile.originalname}"`,
          'Content-Type': imageFile.mimetype,
        },
        body: imageFile.buffer
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
    slug: blog.slug,
    excerpt: blog.meta_description,
    ...(featuredMediaId && { featured_media: featuredMediaId }),
    ...(req.body.categoryIds?.length && { categories: req.body.categoryIds.map(Number) }),
    meta: { _yoast_wpseo_metadesc: blog.meta_description, _yoast_wpseo_focuskw: blog.target_keyword }
  };

  // Set status and publish date
  const publishDate = req.body.publishDate;
  if (publishDate) {
    const pd = new Date(publishDate);
    if (pd > new Date()) {
      wpPayload.status = 'future';
      wpPayload.date = pd.toISOString();
    } else {
      wpPayload.status = 'draft';
    }
  } else {
    wpPayload.status = 'draft';
  }

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
