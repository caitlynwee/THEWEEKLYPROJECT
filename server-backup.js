require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { createSessionStore } = require('./session-store');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const slugify = require('slugify');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const { marked } = require('marked');
const sanitizeHtml = require('sanitize-html');
const db = require('./db');
require('./seed');
const app = express();
const port = Number(process.env.PORT || 3000);
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/$/, '');
const stripe = process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('replace') ? require('stripe')(process.env.STRIPE_SECRET_KEY) : null;
const stripeReady = !!(stripe && process.env.STRIPE_MONTHLY_PRICE_ID && process.env.STRIPE_ANNUAL_PRICE_ID && !process.env.STRIPE_MONTHLY_PRICE_ID.includes('replace') && !process.env.STRIPE_ANNUAL_PRICE_ID.includes('replace'));
const active = s => ['active', 'trialing'].includes(s);
const html = md => sanitizeHtml(marked.parse(md || ''), { allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'img']), allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, a: ['href', 'name', 'target', 'rel'], img: ['src', 'alt'] }, allowedSchemes: ['http', 'https', 'mailto'] });
const clean = v => typeof v === 'string' ? v.trim() : '';
const userById = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const publicArticle = slug => db.prepare("SELECT * FROM articles WHERE slug=? AND status='published'").get(slug);
const safeNext = val => /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(val || '') ? val : '/account';
app.set('view engine', 'ejs');
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),

                "img-src": ["'self'", "data:"],

                "form-action": [
                    "'self'",
                    "https://checkout.stripe.com",
                    "https://billing.stripe.com"
                ]
            }
        }
    })
);
app.use(express.static('public'));
// Stripe verification needs the raw request body, ahead of JSON/urlencoded parsers.
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET || process.env.STRIPE_WEBHOOK_SECRET.includes('replace'))
        return res.sendStatus(503);
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    }
    catch (e) {
        return res.status(400).send('Invalid signature');
    }
    if (db.prepare('SELECT id FROM webhook_events WHERE id=?').get(event.id))
        return res.json({ received: true });
    try {
        const obj = event.data.object;
        if (event.type === 'checkout.session.completed' && obj.mode === 'subscription') {
            const u = userById(Number(obj.client_reference_id)) || db.prepare('SELECT * FROM users WHERE stripe_customer_id=?').get(obj.customer);
            if (u)
                db.prepare('UPDATE users SET stripe_customer_id=?,stripe_subscription_id=? WHERE id=?').run(obj.customer, obj.subscription, u.id);
            if (obj.subscription)
                await syncSubscription(obj.subscription);
        }
        if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(event.type)) {
            // Fetch the current state to avoid stale out-of-order webhook updates.
            await syncSubscription(obj.id);
            if (event.type === 'customer.subscription.deleted') {
                db.prepare("UPDATE users SET subscription_status = 'canceled' WHERE stripe_subscription_id = ?").run(obj.id);
            }
        }
        if (['invoice.paid', 'invoice.payment_failed'].includes(event.type)) {
            const sid = typeof obj.subscription === 'string' ? obj.subscription : obj.subscription?.id;
            if (sid)
                await syncSubscription(sid);
        }
        db.prepare('INSERT OR IGNORE INTO webhook_events(id,type) VALUES(?,?)').run(event.id, event.type);
        res.json({ received: true });
    }
    catch (e) {
        console.error('Webhook processing error:', e);
        res.sendStatus(500);
    }
});
async function syncSubscription(id) {
    let sub;
    try {
        sub = await stripe.subscriptions.retrieve(id);
    }
    catch (e) {
        if (e.code === 'resource_missing') {
            db.prepare("UPDATE users SET subscription_status = 'canceled' WHERE stripe_subscription_id = ?").run(id);
            return;
        }
        throw e;
    }
    const cust = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
    const monthly = process.env.STRIPE_MONTHLY_PRICE_ID, annual = process.env.STRIPE_ANNUAL_PRICE_ID;
    const ids = (sub.items?.data || []).map(i => i.price.id);
    const plan = ids.includes(annual) ? 'annual' : ids.includes(monthly) ? 'monthly' : null;
    const userId = Number(sub.metadata?.weekly_user_id || 0);
    if (userId) {
        db.prepare(`
      UPDATE users SET
        stripe_customer_id = ?, stripe_subscription_id = ?,
        subscription_status = ?, plan = ?
      WHERE id = ? AND role = 'reader'
        AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)
    `).run(cust, sub.id, sub.status, plan, userId, cust);
    }
    db.prepare(`
    UPDATE users SET
      stripe_customer_id = ?, stripe_subscription_id = ?,
      subscription_status = ?, plan = ?
    WHERE stripe_customer_id = ? OR stripe_subscription_id = ?
  `).run(cust, sub.id, sub.status, plan, cust, sub.id);
}
app.use(express.urlencoded({ extended: false, limit: '100kb' }));
app.use(express.json({ limit: '100kb' }));
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
    throw new Error('A strong SESSION_SECRET of at least 32 characters is required in production.');
}
if (process.env.NODE_ENV === 'production')
    app.set('trust proxy', 1);
const sessionStore = createSessionStore(session, db);
app.use(session({
    store: sessionStore,
    name: 'weekly.sid',
    secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 86400000
    }
}));
const sessionCleanup = setInterval(() => sessionStore.purgeExpired(), 60 * 60 * 1000);
sessionCleanup.unref();
app.use((req, res, next) => {
    if (!req.session.csrf)
        req.session.csrf = crypto.randomBytes(24).toString('hex');
    if (req.method === 'POST' && req.path !== '/webhooks/stripe') {
        const token = req.body?._csrf || req.get('x-csrf-token');
        if (!token || token !== req.session.csrf)
            return res.status(403).send('Invalid form token. Refresh and try again.');
    }
    req.user = req.session.userId ? userById(req.session.userId) : null;
    res.locals.user = req.user;
    res.locals.csrf = req.session.csrf;
    res.locals.displayMonthly = process.env.MONTHLY_DISPLAY_PRICE || 'S$12';
    res.locals.displayAnnual = process.env.ANNUAL_DISPLAY_PRICE || 'S$120';
    res.locals.stripeReady = stripeReady;
    res.locals.path = req.path;
    res.locals.isPaid = !!(req.user && (req.user.role === 'admin' || active(req.user.subscription_status)));
    res.locals.flash = req.session.flash || '';
    delete req.session.flash;
    res.locals.html = html;
    res.locals.appUrl = appUrl;
    next();
});
const flash = (req, msg) => req.session.flash = msg;
const requireLogin = (req, res, next) => req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.path));
const requireAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).render('error', { title: 'Access denied', message: 'This page is for editors only.' });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 25, standardHeaders: 'draft-7', legacyHeaders: false });
app.get('/', (req, res) => {
    const articles = db.prepare("SELECT * FROM articles WHERE status='published' ORDER BY featured DESC,published_at DESC LIMIT 8").all();
    res.render('home', { title: 'Independent thinking. Unfiltered markets.', articles });
});
app.get('/articles', (req, res) => {
    const category = clean(req.query.category);
    const articles = category ? db.prepare("SELECT * FROM articles WHERE status='published' AND category=? ORDER BY published_at DESC").all(category) : db.prepare("SELECT * FROM articles WHERE status='published' ORDER BY published_at DESC").all();
    const categories = db.prepare("SELECT DISTINCT category FROM articles WHERE status='published' ORDER BY category").all().map(x => x.category);
    res.render('articles', { title: 'The archive', articles, categories, category });
});
app.get('/articles/:slug', (req, res) => {
    const article = publicArticle(req.params.slug);
    if (!article)
        return res.status(404).render('error', { title: 'Article not found', message: 'This article is not available.' });
    res.render('article', { title: article.title, article, preview: !res.locals.isPaid });
});
app.get('/pricing', (req, res) => res.render('pricing', { title: 'Membership' }));
app.get('/about', (req, res) => res.render('about', { title: 'About The Weekly' }));
app.get('/login', (req, res) => res.render('auth', { title: 'Sign in', mode: 'login', next: safeNext(req.query.next) }));
app.get('/register', (req, res) => res.render('auth', { title: 'Create your account', mode: 'register', next: safeNext(req.query.next) }));
app.post('/register', authLimiter, async (req, res) => {
    const email = clean(req.body.email).toLowerCase(), name = clean(req.body.name), password = req.body.password || '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 10 || name.length < 2) {
        flash(req, 'Enter a valid email, name and password of at least 10 characters.');
        return res.redirect('/register');
    }
    try {
        const result = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(email, await bcrypt.hash(password, 12), name);
        req.session.regenerate(err => { if (err)
            return res.status(500).end(); req.session.userId = result.lastInsertRowid; req.session.csrf = crypto.randomBytes(24).toString('hex'); res.redirect('/pricing'); });
    }
    catch (e) {
        flash(req, 'That email is already registered. Sign in instead.');
        res.redirect('/register');
    }
});
app.post('/login', authLimiter, async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if (!user || !(await bcrypt.compare(req.body.password || '', user.password_hash))) {
        flash(req, 'Incorrect email or password.');
        return res.redirect('/login');
    }
    req.session.regenerate(err => { if (err)
        return res.status(500).end(); req.session.userId = user.id; req.session.csrf = crypto.randomBytes(24).toString('hex'); res.redirect(safeNext(req.body.next)); });
});
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/')));
app.get('/account', requireLogin, (req, res) => res.render('account', { title: 'Your account' }));
app.post('/account/preferences', requireLogin, (req, res) => { db.prepare('UPDATE users SET email_opt_in=? WHERE id=?').run(req.body.email_opt_in === 'on' ? 1 : 0, req.user.id); flash(req, 'Email preferences saved.'); res.redirect('/account'); });
app.post('/billing/checkout', requireLogin, async (req, res) => {
    if (!stripeReady)
        return res.status(503).render('error', { title: 'Stripe not configured', message: 'The administrator must configure Stripe test API keys and monthly/annual Price IDs.' });
    if (active(req.user.subscription_status))
        return res.redirect('/account');
    const plan = req.body.plan;
    const price = plan === 'monthly' ? process.env.STRIPE_MONTHLY_PRICE_ID : plan === 'annual' ? process.env.STRIPE_ANNUAL_PRICE_ID : null;
    if (!price)
        return res.sendStatus(400);
    try {
        let customer = req.user.stripe_customer_id;
        if (!customer) {
            const c = await stripe.customers.create({ email: req.user.email, name: req.user.name, metadata: { weekly_user_id: String(req.user.id) } });
            customer = c.id;
            db.prepare('UPDATE users SET stripe_customer_id=? WHERE id=?').run(customer, req.user.id);
        }
        const session = await stripe.checkout.sessions.create({ mode: 'subscription', customer, client_reference_id: String(req.user.id), line_items: [{ price, quantity: 1 }], automatic_tax: { enabled: process.env.ENABLE_STRIPE_TAX === 'true' }, billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' }, success_url: appUrl + '/account?checkout=success', cancel_url: appUrl + '/pricing?checkout=cancel', subscription_data: { metadata: { weekly_user_id: String(req.user.id) } } });
        res.redirect(303, session.url);
    }
    catch (e) {
        console.error('Stripe checkout:', e.message);
        res.status(500).render('error', { title: 'Checkout unavailable', message: 'Could not open checkout. Check Stripe configuration and tax registrations.' });
    }
});
app.post('/billing/portal', requireLogin, async (req, res) => {
    if (!stripe || !req.user.stripe_customer_id)
        return res.redirect('/pricing');
    try {
        const portal = await stripe.billingPortal.sessions.create({ customer: req.user.stripe_customer_id, return_url: appUrl + '/account' });
        res.redirect(303, portal.url);
    }
    catch (e) {
        console.error(e.message);
        res.status(500).render('error', { title: 'Portal unavailable', message: 'Configure the Stripe Customer Portal in your Stripe Dashboard.' });
    }
});
app.get('/admin', requireAdmin, (req, res) => {
    const stats = { articles: db.prepare("SELECT count(*) n FROM articles WHERE status='published'").get().n, drafts: db.prepare("SELECT count(*) n FROM articles WHERE status='draft'").get().n, readers: db.prepare('SELECT count(*) n FROM users WHERE role=?').get('reader').n, subscribers: db.prepare("SELECT count(*) n FROM users WHERE subscription_status IN ('active','trialing')").get().n, sent: db.prepare("SELECT count(*) n FROM campaigns WHERE status='sent'").get().n };
    const articles = db.prepare('SELECT * FROM articles ORDER BY updated_at DESC LIMIT 6').all();
    const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 5').all();
    res.render('dashboard', { title: 'Overview', stats, articles, campaigns });
});
app.get('/admin/articles', requireAdmin, (req, res) => res.render('admin-articles', { title: 'Manage articles', articles: db.prepare('SELECT * FROM articles ORDER BY updated_at DESC').all() }));
app.get('/admin/articles/new', requireAdmin, (req, res) => res.render('article-form', { title: 'New article', article: null }));
app.get('/admin/articles/:id/edit', requireAdmin, (req, res) => { const article = db.prepare('SELECT * FROM articles WHERE id=?').get(req.params.id); if (!article)
    return res.sendStatus(404); res.render('article-form', { title: 'Edit article', article }); });
app.post('/admin/articles/save', requireAdmin, (req, res) => {
    const id = Number(req.body.id || 0), title = clean(req.body.title), excerpt = clean(req.body.excerpt), body = clean(req.body.body), category = clean(req.body.category) || 'Markets', author = clean(req.body.author) || 'The Weekly';
    if (title.length < 4 || excerpt.length < 15 || body.length < 30) {
        flash(req, 'Please complete the title, excerpt and body.');
        return res.redirect(id ? `/admin/articles/${id}/edit` : '/admin/articles/new');
    }
    const status = req.body.status === 'published' ? 'published' : 'draft';
    const featured = req.body.featured === 'on' ? 1 : 0;
    if (id) {
        const old = db.prepare('SELECT * FROM articles WHERE id=?').get(id);
        if (!old)
            return res.sendStatus(404);
        db.prepare("UPDATE articles SET title=?,category=?,excerpt=?,body=?,author=?,status=?,featured=?,published_at=CASE WHEN ?='published' AND published_at IS NULL THEN CURRENT_TIMESTAMP ELSE published_at END,updated_at=CURRENT_TIMESTAMP WHERE id=?").run(title, category, excerpt, body, author, status, featured, status, id);
    }
    else {
        let slug = slugify(title, { lower: true, strict: true }).slice(0, 75) || 'article';
        if (db.prepare('SELECT id FROM articles WHERE slug=?').get(slug))
            slug += '-' + crypto.randomBytes(3).toString('hex');
        db.prepare("INSERT INTO articles(slug,title,category,excerpt,body,author,status,featured,published_at) VALUES(?,?,?,?,?,?,?,?,CASE WHEN ?='published' THEN CURRENT_TIMESTAMP ELSE NULL END)").run(slug, title, category, excerpt, body, author, status, featured, status);
    }
    flash(req, 'Article saved.');
    res.redirect('/admin/articles');
});
app.post('/admin/articles/:id/delete', requireAdmin, (req, res) => { db.prepare('DELETE FROM articles WHERE id=?').run(req.params.id); flash(req, 'Article deleted.'); res.redirect('/admin/articles'); });
app.get('/admin/subscribers', requireAdmin, (req, res) => res.render('subscribers', { title: 'Subscribers', subscribers: db.prepare("SELECT id,email,name,role,subscription_status,plan,email_opt_in,created_at FROM users ORDER BY created_at DESC").all() }));
app.get('/admin/campaigns', requireAdmin, (req, res) => res.render('campaigns', { title: 'Email campaigns', campaigns: db.prepare('SELECT c.*,a.title article_title,(SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.status=? ) successful,(SELECT count(*) FROM deliveries d WHERE d.campaign_id=c.id AND d.status=? ) failed FROM campaigns c LEFT JOIN articles a ON a.id=c.article_id ORDER BY c.created_at DESC').all('sent', 'failed'), articles: db.prepare("SELECT id,title FROM articles WHERE status='published' ORDER BY published_at DESC").all() }));
app.post('/admin/campaigns', requireAdmin, (req, res) => {
    const subject = clean(req.body.subject), intro = clean(req.body.intro), articleId = Number(req.body.article_id || 0);
    if (subject.length < 5 || intro.length < 10) {
        flash(req, 'Provide a subject and introductory message.');
        return res.redirect('/admin/campaigns');
    }
    const article = articleId ? db.prepare("SELECT id FROM articles WHERE id=? AND status='published'").get(articleId) : null;
    db.prepare('INSERT INTO campaigns(subject,intro,article_id) VALUES(?,?,?)').run(subject, intro, article?.id || null);
    flash(req, 'Campaign draft saved.');
    res.redirect('/admin/campaigns');
});
function mailTransport() { if (!process.env.SMTP_HOST || !process.env.EMAIL_FROM)
    throw new Error('SMTP settings are missing'); return nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined }); }
let sending = false;
async function sendCampaign(id) {
    if (sending)
        throw new Error('Another campaign is being sent');
    const campaign = db.prepare("SELECT c.*,a.slug,a.title article_title,a.excerpt FROM campaigns c LEFT JOIN articles a ON a.id=c.article_id WHERE c.id=?").get(id);
    if (!campaign || campaign.status === 'sent')
        throw new Error('Campaign unavailable or already sent');
    const transporter = mailTransport();
    sending = true;
    try {
        db.prepare("UPDATE campaigns SET status='sending' WHERE id=?").run(id);
        const recipients = db.prepare("SELECT id,email,name FROM users WHERE role='reader' AND email_opt_in=1 AND subscription_status IN ('active','trialing')").all();
        for (const recipient of recipients) {
            if (db.prepare("SELECT id FROM deliveries WHERE campaign_id=? AND user_id=? AND status='sent'").get(id, recipient.id))
                continue;
            const articleLink = campaign.slug ? appUrl + '/articles/' + encodeURIComponent(campaign.slug) : appUrl + '/articles';
            const body = `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#16252e"><h1>THE WEEKLY</h1><p>${escapeHTML(campaign.intro).replace(/\n/g, '<br>')}</p>${campaign.article_title ? `<h2>${escapeHTML(campaign.article_title)}</h2><p>${escapeHTML(campaign.excerpt)}</p>` : ''}<p><a href="${articleLink}">Read on THE WEEKLY →</a></p><hr><p style="font-size:12px;color:#64748b">Manage email preferences: <a href="${appUrl}/account">Your account</a></p></div>`;
            try {
                await transporter.sendMail({ from: process.env.EMAIL_FROM, to: recipient.email, subject: campaign.subject, text: `${campaign.intro}\n\n${campaign.article_title || ''}\n${articleLink}\n\nManage preferences: ${appUrl}/account`, html: body });
                db.prepare("INSERT INTO deliveries(campaign_id,user_id,status,error) VALUES(?,?,'sent',NULL) ON CONFLICT(campaign_id,user_id) DO UPDATE SET status='sent',error=NULL,sent_at=CURRENT_TIMESTAMP").run(id, recipient.id);
            }
            catch (e) {
                db.prepare("INSERT INTO deliveries(campaign_id,user_id,status,error) VALUES(?,?,'failed',?) ON CONFLICT(campaign_id,user_id) DO UPDATE SET status='failed',error=excluded.error,sent_at=CURRENT_TIMESTAMP").run(id, recipient.id, String(e.message).slice(0, 300));
            }
        }
        const failures = db.prepare("SELECT count(*) n FROM deliveries WHERE campaign_id=? AND status='failed'").get(id).n;
        db.prepare("UPDATE campaigns SET status=?, sent_at=CASE WHEN ?='sent' THEN CURRENT_TIMESTAMP ELSE sent_at END WHERE id=?").run(failures ? 'partial' : 'sent', failures ? 'partial' : 'sent', id);
        return { recipients: recipients.length, failures };
    }
    finally {
        sending = false;
    }
}
function escapeHTML(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
app.post('/admin/campaigns/:id/send', requireAdmin, async (req, res) => {
    try {
        const result = await sendCampaign(Number(req.params.id));
        flash(req, `Campaign processed: ${result.recipients} eligible recipients, ${result.failures} failed. Review results below.`);
    }
    catch (e) {
        flash(req, 'Send failed: ' + e.message);
    }
    res.redirect('/admin/campaigns');
});
// Schedule a DRAFT campaign in the dashboard first; cron sends the oldest one once per week.
// Use only one scheduler instance in deployment, or replace with a distributed queue.
if (process.env.ENABLE_SCHEDULED_SEND === 'true') {
    cron.schedule(process.env.NEWSLETTER_CRON || '0 9 * * 1', async () => {
        const week = new Date().toISOString().slice(0, 10);
        const key = `weekly-${week}`;
        if (db.prepare('SELECT run_key FROM scheduled_runs WHERE run_key=?').get(key))
            return;
        const campaign = db.prepare("SELECT id FROM campaigns WHERE status='draft' ORDER BY created_at ASC LIMIT 1").get();
        if (!campaign)
            return;
        db.prepare('INSERT OR IGNORE INTO scheduled_runs(run_key) VALUES(?)').run(key);
        try {
            await sendCampaign(campaign.id);
        }
        catch (e) {
            console.error('Scheduled email failure', e);
            db.prepare('DELETE FROM scheduled_runs WHERE run_key=?').run(key);
        }
    }, { timezone: process.env.NEWSLETTER_TIMEZONE || 'Asia/Singapore' });
}
app.use((req, res) => res.status(404).render('error', { title: 'Page not found', message: 'The page you requested could not be found.' }));
app.listen(port, () => console.log(`THE WEEKLY running at ${appUrl} | Stripe ${stripeReady ? 'configured' : 'not configured'}`));
