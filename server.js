
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
const appUrl = (
    process.env.APP_URL || `http://localhost:${port}`
).replace(/\/$/, '');

const stripe =
    process.env.STRIPE_SECRET_KEY &&
    !process.env.STRIPE_SECRET_KEY.includes('replace')
        ? require('stripe')(process.env.STRIPE_SECRET_KEY)
        : null;

const stripeReady = !!(
    stripe &&
    process.env.STRIPE_MONTHLY_PRICE_ID &&
    process.env.STRIPE_ANNUAL_PRICE_ID &&
    !process.env.STRIPE_MONTHLY_PRICE_ID.includes('replace') &&
    !process.env.STRIPE_ANNUAL_PRICE_ID.includes('replace')
);

const active = status =>
    ['active', 'trialing'].includes(status);

const html = markdown =>
    sanitizeHtml(marked.parse(markdown || ''), {
        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
            'h1',
            'h2',
            'img'
        ]),
        allowedAttributes: {
            ...sanitizeHtml.defaults.allowedAttributes,
            a: ['href', 'name', 'target', 'rel'],
            img: ['src', 'alt']
        },
        allowedSchemes: ['http', 'https', 'mailto']
    });

const clean = value =>
    typeof value === 'string' ? value.trim() : '';

const userById = id =>
    db.prepare('SELECT * FROM users WHERE id = ?').get(id);

const publicArticle = slug =>
    db.prepare(
        "SELECT * FROM articles WHERE slug = ? AND status = 'published'"
    ).get(slug);

const safeNext = value =>
    /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(value || '')
        ? value
        : '/account';

// --------------------------------------------------
// Application configuration
// --------------------------------------------------

app.set('view engine', 'ejs');

app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                ...helmet.contentSecurityPolicy.getDefaultDirectives(),

                'img-src': ["'self'", 'data:'],

                'form-action': [
                    "'self'",
                    'https://checkout.stripe.com',
                    'https://billing.stripe.com'
                ]
            }
        }
    })
);

app.use(express.static('public'));

// --------------------------------------------------
// Stripe webhook
// --------------------------------------------------

app.post(
    '/webhooks/stripe',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        if (
            !stripe ||
            !process.env.STRIPE_WEBHOOK_SECRET ||
            process.env.STRIPE_WEBHOOK_SECRET.includes('replace')
        ) {
            return res.sendStatus(503);
        }

        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                req.headers['stripe-signature'],
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (error) {
            return res.status(400).send('Invalid signature');
        }

        const existingEvent = db.prepare(
            'SELECT id FROM webhook_events WHERE id = ?'
        ).get(event.id);

        if (existingEvent) {
            return res.json({ received: true });
        }

        try {
            const object = event.data.object;

            if (
                event.type === 'checkout.session.completed' &&
                object.mode === 'subscription'
            ) {
                const user =
                    userById(Number(object.client_reference_id)) ||
                    db.prepare(
                        'SELECT * FROM users WHERE stripe_customer_id = ?'
                    ).get(object.customer);

                if (user) {
                    db.prepare(`
                        UPDATE users
                        SET stripe_customer_id = ?,
                            stripe_subscription_id = ?
                        WHERE id = ?
                    `).run(
                        object.customer,
                        object.subscription,
                        user.id
                    );
                }

                if (object.subscription) {
                    await syncSubscription(object.subscription);
                }
            }

            if (
                [
                    'customer.subscription.created',
                    'customer.subscription.updated',
                    'customer.subscription.deleted'
                ].includes(event.type)
            ) {
                await syncSubscription(object.id);

                if (
                    event.type === 'customer.subscription.deleted'
                ) {
                    db.prepare(`
                        UPDATE users
                        SET subscription_status = 'canceled'
                        WHERE stripe_subscription_id = ?
                    `).run(object.id);
                }
            }

            if (
                [
                    'invoice.paid',
                    'invoice.payment_failed'
                ].includes(event.type)
            ) {
                const subscriptionId =
                    typeof object.subscription === 'string'
                        ? object.subscription
                        : object.subscription?.id;

                if (subscriptionId) {
                    await syncSubscription(subscriptionId);
                }
            }

            db.prepare(`
                INSERT OR IGNORE INTO webhook_events (id, type)
                VALUES (?, ?)
            `).run(event.id, event.type);

            return res.json({ received: true });
        } catch (error) {
            console.error('Webhook processing error:', error);
            return res.sendStatus(500);
        }
    }
);

// --------------------------------------------------
// Stripe subscription synchronisation
// --------------------------------------------------

async function syncSubscription(subscriptionId) {
    let subscription;

    try {
        subscription = await stripe.subscriptions.retrieve(
            subscriptionId
        );
    } catch (error) {
        if (error.code === 'resource_missing') {
            db.prepare(`
                UPDATE users
                SET subscription_status = 'canceled'
                WHERE stripe_subscription_id = ?
            `).run(subscriptionId);

            return;
        }

        throw error;
    }

    const customerId =
        typeof subscription.customer === 'string'
            ? subscription.customer
            : subscription.customer.id;

    const monthlyPriceId =
        process.env.STRIPE_MONTHLY_PRICE_ID;

    const annualPriceId =
        process.env.STRIPE_ANNUAL_PRICE_ID;

    const subscriptionPriceIds = (
        subscription.items?.data || []
    ).map(item => item.price.id);

    const plan = subscriptionPriceIds.includes(annualPriceId)
        ? 'annual'
        : subscriptionPriceIds.includes(monthlyPriceId)
            ? 'monthly'
            : null;

    const userId = Number(
        subscription.metadata?.weekly_user_id || 0
    );

    if (userId) {
        db.prepare(`
            UPDATE users
            SET
                stripe_customer_id = ?,
                stripe_subscription_id = ?,
                subscription_status = ?,
                plan = ?
            WHERE id = ?
              AND role = 'reader'
              AND (
                  stripe_customer_id IS NULL
                  OR stripe_customer_id = ?
              )
        `).run(
            customerId,
            subscription.id,
            subscription.status,
            plan,
            userId,
            customerId
        );
    }

    db.prepare(`
        UPDATE users
        SET
            stripe_customer_id = ?,
            stripe_subscription_id = ?,
            subscription_status = ?,
            plan = ?
        WHERE stripe_customer_id = ?
           OR stripe_subscription_id = ?
    `).run(
        customerId,
        subscription.id,
        subscription.status,
        plan,
        customerId,
        subscription.id
    );
}

/**
 * Synchronises a reader's membership with Stripe.
 *
 * This helps recover paid subscriptions when the
 * original webhook was not received by localhost.
 *
 * Only subscriptions associated with the current
 * reader's Stripe customer and user metadata are used.
 */
async function reconcileReaderMembership(
    user,
    checkoutSessionId
) {
    if (
        !stripe ||
        !user ||
        user.role !== 'reader' ||
        !user.stripe_customer_id
    ) {
        return;
    }

    const expectedUserId = String(user.id);

    const acceptedPrices = new Set(
        [
            process.env.STRIPE_MONTHLY_PRICE_ID,
            process.env.STRIPE_ANNUAL_PRICE_ID
        ].filter(Boolean)
    );

    // Verify the Stripe Checkout session, if provided.
    if (checkoutSessionId) {
        const checkoutSession =
            await stripe.checkout.sessions.retrieve(
                checkoutSessionId
            );

        const validSession =
            checkoutSession.mode === 'subscription' &&
            checkoutSession.status === 'complete' &&
            checkoutSession.customer === user.stripe_customer_id &&
            checkoutSession.client_reference_id === expectedUserId &&
            checkoutSession.subscription;

        if (validSession) {
            await syncSubscription(
                checkoutSession.subscription
            );
        }
    }

    // Find existing subscriptions for this reader.
    const subscriptions = await stripe.subscriptions.list({
        customer: user.stripe_customer_id,
        status: 'all',
        limit: 100
    });

    const matchingSubscriptions =
        subscriptions.data.filter(subscription => {
            const correctUser =
                subscription.metadata?.weekly_user_id ===
                expectedUserId;

            const correctPrice =
                subscription.items?.data?.some(item =>
                    acceptedPrices.has(item.price?.id)
                );

            return correctUser && correctPrice;
        });

    // Prioritise an active subscription.
    const selectedSubscription =
        matchingSubscriptions.find(subscription =>
            active(subscription.status)
        ) || matchingSubscriptions[0];

    if (selectedSubscription) {
        await syncSubscription(selectedSubscription.id);
    }
}

// --------------------------------------------------
// Request and session middleware
// --------------------------------------------------

app.use(express.urlencoded({
    extended: false,
    limit: '100kb'
}));

app.use(express.json({
    limit: '100kb'
}));

if (
    process.env.NODE_ENV === 'production' &&
    (
        !process.env.SESSION_SECRET ||
        process.env.SESSION_SECRET.length < 32
    )
) {
    throw new Error(
        'A strong SESSION_SECRET of at least 32 characters is required in production.'
    );
}

if (process.env.NODE_ENV === 'production') {
    app.set('trust proxy', 1);
}

const sessionStore = createSessionStore(session, db);

app.use(
    session({
        store: sessionStore,
        name: 'weekly.sid',
        secret:
            process.env.SESSION_SECRET ||
            'development-only-change-this-session-secret',
        resave: false,
        saveUninitialized: false,
        cookie: {
            httpOnly: true,
            sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
            maxAge: 7 * 86400000
        }
    })
);

const sessionCleanup = setInterval(
    () => sessionStore.purgeExpired(),
    60 * 60 * 1000
);

sessionCleanup.unref();

app.use((req, res, next) => {
    if (!req.session.csrf) {
        req.session.csrf =
            crypto.randomBytes(24).toString('hex');
    }

    if (
        req.method === 'POST' &&
        req.path !== '/webhooks/stripe'
    ) {
        const token =
            req.body?._csrf ||
            req.get('x-csrf-token');

        if (!token || token !== req.session.csrf) {
            return res.status(403).send(
                'Invalid form token. Refresh and try again.'
            );
        }
    }

    req.user = req.session.userId
        ? userById(req.session.userId)
        : null;

    res.locals.user = req.user;
    res.locals.csrf = req.session.csrf;

    res.locals.displayMonthly =
        process.env.MONTHLY_DISPLAY_PRICE || 'S$12';

    res.locals.displayAnnual =
        process.env.ANNUAL_DISPLAY_PRICE || 'S$120';

    res.locals.stripeReady = stripeReady;
    res.locals.path = req.path;

    res.locals.isPaid = !!(
        req.user &&
        (
            req.user.role === 'admin' ||
            active(req.user.subscription_status)
        )
    );

    res.locals.flash = req.session.flash || '';
    delete req.session.flash;

    res.locals.html = html;
    res.locals.appUrl = appUrl;

    next();
});

// --------------------------------------------------
// Authentication helpers
// --------------------------------------------------

const flash = (req, message) => {
    req.session.flash = message;
};

const requireLogin = (req, res, next) =>
    req.user
        ? next()
        : res.redirect(
            '/login?next=' + encodeURIComponent(req.path)
        );

const requireAdmin = (req, res, next) =>
    req.user?.role === 'admin'
        ? next()
        : res.status(403).render('error', {
            title: 'Access denied',
            message: 'This page is for editors only.'
        });

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 25,
    standardHeaders: 'draft-7',
    legacyHeaders: false
});

// --------------------------------------------------
// Public pages
// --------------------------------------------------

app.get('/', (req, res) => {
    const articles = db.prepare(`
        SELECT *
        FROM articles
        WHERE status = 'published'
        ORDER BY featured DESC, published_at DESC
        LIMIT 8
    `).all();

    res.render('home', {
        title: 'Independent thinking. Unfiltered markets.',
        articles
    });
});

app.get('/articles', (req, res) => {
    const category = clean(req.query.category);

    const articles = category
        ? db.prepare(`
            SELECT *
            FROM articles
            WHERE status = 'published'
              AND category = ?
            ORDER BY published_at DESC
        `).all(category)
        : db.prepare(`
            SELECT *
            FROM articles
            WHERE status = 'published'
            ORDER BY published_at DESC
        `).all();

    const categories = db.prepare(`
        SELECT DISTINCT category
        FROM articles
        WHERE status = 'published'
        ORDER BY category
    `).all().map(item => item.category);

    res.render('articles', {
        title: 'The archive',
        articles,
        categories,
        category
    });
});

app.get('/articles/:slug', (req, res) => {
    const article = publicArticle(req.params.slug);

    if (!article) {
        return res.status(404).render('error', {
            title: 'Article not found',
            message: 'This article is not available.'
        });
    }

    res.render('article', {
        title: article.title,
        article,
        preview: !res.locals.isPaid
    });
});

app.get('/pricing', (req, res) => {
    res.render('pricing', {
        title: 'Membership'
    });
});

app.get('/about', (req, res) => {
    res.render('about', {
        title: 'About The Weekly'
    });
});

// --------------------------------------------------
// Registration and login
// --------------------------------------------------

app.get('/login', (req, res) => {
    res.render('auth', {
        title: 'Sign in',
        mode: 'login',
        next: safeNext(req.query.next)
    });
});

app.get('/register', (req, res) => {
    res.render('auth', {
        title: 'Create your account',
        mode: 'register',
        next: safeNext(req.query.next)
    });
});

app.post('/register', authLimiter, async (req, res) => {
    const email = clean(req.body.email).toLowerCase();
    const name = clean(req.body.name);
    const password = req.body.password || '';

    if (
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        password.length < 10 ||
        name.length < 2
    ) {
        flash(
            req,
            'Enter a valid email, name and password of at least 10 characters.'
        );

        return res.redirect('/register');
    }

    try {
        const result = db.prepare(`
            INSERT INTO users (email, password_hash, name)
            VALUES (?, ?, ?)
        `).run(
            email,
            await bcrypt.hash(password, 12),
            name
        );

        req.session.regenerate(error => {
            if (error) {
                return res.status(500).end();
            }

            req.session.userId = result.lastInsertRowid;

            req.session.csrf =
                crypto.randomBytes(24).toString('hex');

            res.redirect('/pricing');
        });
    } catch (error) {
        flash(
            req,
            'That email is already registered. Sign in instead.'
        );

        res.redirect('/register');
    }
});

app.post('/login', authLimiter, async (req, res) => {
    const email = clean(req.body.email).toLowerCase();

    const user = db.prepare(
        'SELECT * FROM users WHERE email = ?'
    ).get(email);

    if (
        !user ||
        !await bcrypt.compare(
            req.body.password || '',
            user.password_hash
        )
    ) {
        flash(req, 'Incorrect email or password.');
        return res.redirect('/login');
    }

    req.session.regenerate(error => {
        if (error) {
            return res.status(500).end();
        }

        req.session.userId = user.id;

        req.session.csrf =
            crypto.randomBytes(24).toString('hex');

        res.redirect(safeNext(req.body.next));
    });
});

app.post('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// --------------------------------------------------
// Account page with Stripe membership reconciliation
// --------------------------------------------------

app.get('/account', requireLogin, async (req, res) => {
    try {
        const sessionId =
            req.query.checkout === 'success' &&
            typeof req.query.session_id === 'string' &&
            /^cs_(test_)?[a-zA-Z0-9]+$/.test(
                req.query.session_id
            )
                ? req.query.session_id
                : null;

        await reconcileReaderMembership(
            req.user,
            sessionId
        );

        // Reload updated user information from SQLite.
        req.user = userById(req.user.id);

        res.locals.user = req.user;

        res.locals.isPaid =
            req.user.role === 'admin' ||
            active(req.user.subscription_status);
    } catch (error) {
        console.error(
            'Stripe membership reconciliation:',
            error.message
        );
    }

    res.render('account', {
        title: 'Your account'
    });
});

app.post(
    '/account/preferences',
    requireLogin,
    (req, res) => {
        db.prepare(`
            UPDATE users
            SET email_opt_in = ?
            WHERE id = ?
        `).run(
            req.body.email_opt_in === 'on' ? 1 : 0,
            req.user.id
        );

        flash(req, 'Email preferences saved.');
        res.redirect('/account');
    }
);

// --------------------------------------------------
// Stripe Checkout
// --------------------------------------------------

app.post(
    '/billing/checkout',
    requireLogin,
    async (req, res) => {
        if (!stripeReady) {
            return res.status(503).render('error', {
                title: 'Stripe not configured',
                message:
                    'The administrator must configure Stripe test API keys and monthly/annual Price IDs.'
            });
        }

        if (active(req.user.subscription_status)) {
            return res.redirect('/account');
        }

        const plan = req.body.plan;

        const price =
            plan === 'monthly'
                ? process.env.STRIPE_MONTHLY_PRICE_ID
                : plan === 'annual'
                    ? process.env.STRIPE_ANNUAL_PRICE_ID
                    : null;

        if (!price) {
            return res.sendStatus(400);
        }

        try {
            let customer = req.user.stripe_customer_id;

            if (!customer) {
                const createdCustomer =
                    await stripe.customers.create({
                        email: req.user.email,
                        name: req.user.name,
                        metadata: {
                            weekly_user_id: String(req.user.id)
                        }
                    });

                customer = createdCustomer.id;

                db.prepare(`
                    UPDATE users
                    SET stripe_customer_id = ?
                    WHERE id = ?
                `).run(customer, req.user.id);
            }

            const checkoutSession =
                await stripe.checkout.sessions.create({
                    mode: 'subscription',

                    customer,

                    client_reference_id: String(req.user.id),

                    line_items: [
                        {
                            price,
                            quantity: 1
                        }
                    ],

                    automatic_tax: {
                        enabled:
                            process.env.ENABLE_STRIPE_TAX === 'true'
                    },

                    billing_address_collection: 'required',

                    customer_update: {
                        address: 'auto',
                        name: 'auto'
                    },

                    success_url:
                        appUrl +
                        '/account?checkout=success&session_id={CHECKOUT_SESSION_ID}',

                    cancel_url:
                        appUrl + '/pricing?checkout=cancel',

                    subscription_data: {
                        metadata: {
                            weekly_user_id: String(req.user.id)
                        }
                    }
                });

            res.redirect(303, checkoutSession.url);
        } catch (error) {
            console.error(
                'Stripe checkout:',
                error.message
            );

            res.status(500).render('error', {
                title: 'Checkout unavailable',
                message:
                    'Could not open checkout. Check Stripe configuration and tax registrations.'
            });
        }
    }
);

// --------------------------------------------------
// Stripe Customer Portal
// --------------------------------------------------

app.post(
    '/billing/portal',
    requireLogin,
    async (req, res) => {
        if (!stripe || !req.user.stripe_customer_id) {
            return res.redirect('/pricing');
        }

        try {
            const portal =
                await stripe.billingPortal.sessions.create({
                    customer: req.user.stripe_customer_id,
                    return_url: appUrl + '/account'
                });

            res.redirect(303, portal.url);
        } catch (error) {
            console.error(error.message);

            res.status(500).render('error', {
                title: 'Portal unavailable',
                message:
                    'Configure the Stripe Customer Portal in your Stripe Dashboard.'
            });
        }
    }
);

// --------------------------------------------------
// Admin dashboard
// --------------------------------------------------

app.get('/admin', requireAdmin, (req, res) => {
    const stats = {
        articles: db.prepare(`
            SELECT count(*) n
            FROM articles
            WHERE status = 'published'
        `).get().n,

        drafts: db.prepare(`
            SELECT count(*) n
            FROM articles
            WHERE status = 'draft'
        `).get().n,

        readers: db.prepare(`
            SELECT count(*) n
            FROM users
            WHERE role = ?
        `).get('reader').n,

        subscribers: db.prepare(`
            SELECT count(*) n
            FROM users
            WHERE subscription_status IN ('active', 'trialing')
        `).get().n,

        sent: db.prepare(`
            SELECT count(*) n
            FROM campaigns
            WHERE status = 'sent'
        `).get().n
    };

    const articles = db.prepare(`
        SELECT *
        FROM articles
        ORDER BY updated_at DESC
        LIMIT 6
    `).all();

    const campaigns = db.prepare(`
        SELECT *
        FROM campaigns
        ORDER BY created_at DESC
        LIMIT 5
    `).all();

    res.render('dashboard', {
        title: 'Overview',
        stats,
        articles,
        campaigns
    });
});

// --------------------------------------------------
// Article management
// --------------------------------------------------

app.get('/admin/articles', requireAdmin, (req, res) => {
    res.render('admin-articles', {
        title: 'Manage articles',
        articles: db.prepare(`
            SELECT *
            FROM articles
            ORDER BY updated_at DESC
        `).all()
    });
});

app.get('/admin/articles/new', requireAdmin, (req, res) => {
    res.render('article-form', {
        title: 'New article',
        article: null
    });
});

app.get(
    '/admin/articles/:id/edit',
    requireAdmin,
    (req, res) => {
        const article = db.prepare(
            'SELECT * FROM articles WHERE id = ?'
        ).get(req.params.id);

        if (!article) {
            return res.sendStatus(404);
        }

        res.render('article-form', {
            title: 'Edit article',
            article
        });
    }
);

app.post(
    '/admin/articles/save',
    requireAdmin,
    (req, res) => {
        const id = Number(req.body.id || 0);
        const title = clean(req.body.title);
        const excerpt = clean(req.body.excerpt);
        const body = clean(req.body.body);

        const category =
            clean(req.body.category) || 'Markets';

        const author =
            clean(req.body.author) || 'The Weekly';

        if (
            title.length < 4 ||
            excerpt.length < 15 ||
            body.length < 30
        ) {
            flash(
                req,
                'Please complete the title, excerpt and body.'
            );

            return res.redirect(
                id
                    ? `/admin/articles/${id}/edit`
                    : '/admin/articles/new'
            );
        }

        const status =
            req.body.status === 'published'
                ? 'published'
                : 'draft';

        const featured =
            req.body.featured === 'on' ? 1 : 0;

        if (id) {
            const old = db.prepare(
                'SELECT * FROM articles WHERE id = ?'
            ).get(id);

            if (!old) {
                return res.sendStatus(404);
            }

            db.prepare(`
                UPDATE articles
                SET
                    title = ?,
                    category = ?,
                    excerpt = ?,
                    body = ?,
                    author = ?,
                    status = ?,
                    featured = ?,
                    published_at = CASE
                        WHEN ? = 'published'
                             AND published_at IS NULL
                        THEN CURRENT_TIMESTAMP
                        ELSE published_at
                    END,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = ?
            `).run(
                title,
                category,
                excerpt,
                body,
                author,
                status,
                featured,
                status,
                id
            );
        } else {
            let slug =
                slugify(title, {
                    lower: true,
                    strict: true
                }).slice(0, 75) || 'article';

            const existingSlug = db.prepare(
                'SELECT id FROM articles WHERE slug = ?'
            ).get(slug);

            if (existingSlug) {
                slug +=
                    '-' +
                    crypto.randomBytes(3).toString('hex');
            }

            db.prepare(`
                INSERT INTO articles (
                    slug,
                    title,
                    category,
                    excerpt,
                    body,
                    author,
                    status,
                    featured,
                    published_at
                )
                VALUES (
                    ?, ?, ?, ?, ?, ?, ?, ?,
                    CASE
                        WHEN ? = 'published'
                        THEN CURRENT_TIMESTAMP
                        ELSE NULL
                    END
                )
            `).run(
                slug,
                title,
                category,
                excerpt,
                body,
                author,
                status,
                featured,
                status
            );
        }

        flash(req, 'Article saved.');
        res.redirect('/admin/articles');
    }
);

app.post(
    '/admin/articles/:id/delete',
    requireAdmin,
    (req, res) => {
        db.prepare(
            'DELETE FROM articles WHERE id = ?'
        ).run(req.params.id);

        flash(req, 'Article deleted.');
        res.redirect('/admin/articles');
    }
);

// --------------------------------------------------
// Subscriber management
// --------------------------------------------------

app.get(
    '/admin/subscribers',
    requireAdmin,
    (req, res) => {
        const subscribers = db.prepare(`
            SELECT
                id,
                email,
                name,
                role,
                subscription_status,
                plan,
                email_opt_in,
                created_at
            FROM users
            ORDER BY created_at DESC
        `).all();

        res.render('subscribers', {
            title: 'Subscribers',
            subscribers
        });
    }
);

// --------------------------------------------------
// Newsletter campaigns
// --------------------------------------------------

app.get(
    '/admin/campaigns',
    requireAdmin,
    (req, res) => {
        const campaigns = db.prepare(`
            SELECT
                c.*,
                a.title article_title,

                (
                    SELECT count(*)
                    FROM deliveries d
                    WHERE d.campaign_id = c.id
                      AND d.status = ?
                ) successful,

                (
                    SELECT count(*)
                    FROM deliveries d
                    WHERE d.campaign_id = c.id
                      AND d.status = ?
                ) failed

            FROM campaigns c

            LEFT JOIN articles a
                ON a.id = c.article_id

            ORDER BY c.created_at DESC
        `).all('sent', 'failed');

        const articles = db.prepare(`
            SELECT id, title
            FROM articles
            WHERE status = 'published'
            ORDER BY published_at DESC
        `).all();

        res.render('campaigns', {
            title: 'Email campaigns',
            campaigns,
            articles
        });
    }
);

app.post(
    '/admin/campaigns',
    requireAdmin,
    (req, res) => {
        const subject = clean(req.body.subject);
        const intro = clean(req.body.intro);
        const articleId = Number(req.body.article_id || 0);

        if (
            subject.length < 5 ||
            intro.length < 10
        ) {
            flash(
                req,
                'Provide a subject and introductory message.'
            );

            return res.redirect('/admin/campaigns');
        }

        const article = articleId
            ? db.prepare(`
                SELECT id
                FROM articles
                WHERE id = ?
                  AND status = 'published'
            `).get(articleId)
            : null;

        db.prepare(`
            INSERT INTO campaigns (
                subject,
                intro,
                article_id
            )
            VALUES (?, ?, ?)
        `).run(
            subject,
            intro,
            article?.id || null
        );

        flash(req, 'Campaign draft saved.');
        res.redirect('/admin/campaigns');
    }
);

// --------------------------------------------------
// Email configuration
// --------------------------------------------------

function mailTransport() {
    if (
        !process.env.SMTP_HOST ||
        !process.env.EMAIL_FROM
    ) {
        throw new Error('SMTP settings are missing');
    }

    return nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: process.env.SMTP_SECURE === 'true',

        auth: process.env.SMTP_USER
            ? {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
            : undefined
    });
}

function escapeHTML(value) {
    return String(value || '').replace(
        /[&<>"']/g,
        character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]
    );
}

// --------------------------------------------------
// Sending newsletter campaigns
// --------------------------------------------------

let sending = false;

async function sendCampaign(id) {
    if (sending) {
        throw new Error(
            'Another campaign is being sent'
        );
    }

    const campaign = db.prepare(`
        SELECT
            c.*,
            a.slug,
            a.title article_title,
            a.excerpt
        FROM campaigns c
        LEFT JOIN articles a
            ON a.id = c.article_id
        WHERE c.id = ?
    `).get(id);

    if (
        !campaign ||
        campaign.status === 'sent'
    ) {
        throw new Error(
            'Campaign unavailable or already sent'
        );
    }

    const transporter = mailTransport();

    sending = true;

    try {
        db.prepare(`
            UPDATE campaigns
            SET status = 'sending'
            WHERE id = ?
        `).run(id);

        const recipients = db.prepare(`
            SELECT id, email, name
            FROM users
            WHERE role = 'reader'
              AND email_opt_in = 1
              AND subscription_status IN (
                  'active',
                  'trialing'
              )
        `).all();

        for (const recipient of recipients) {
            const alreadySent = db.prepare(`
                SELECT id
                FROM deliveries
                WHERE campaign_id = ?
                  AND user_id = ?
                  AND status = 'sent'
            `).get(id, recipient.id);

            if (alreadySent) {
                continue;
            }

            const articleLink = campaign.slug
                ? appUrl +
                  '/articles/' +
                  encodeURIComponent(campaign.slug)
                : appUrl + '/articles';

            const emailBody = `
                <div style="
                    font-family: Arial, sans-serif;
                    max-width: 620px;
                    margin: auto;
                    color: #16252e;
                ">
                    <h1>THE WEEKLY</h1>

                    <p>
                        ${escapeHTML(campaign.intro).replace(/\n/g, '<br>')}
                    </p>

                    ${
                        campaign.article_title
                            ? `
                                <h2>
                                    ${escapeHTML(campaign.article_title)}
                                </h2>
                                <p>
                                    ${escapeHTML(campaign.excerpt)}
                                </p>
                            `
                            : ''
                    }

                    <p>
                        <a href="${articleLink}">
                            Read on THE WEEKLY →
                        </a>
                    </p>

                    <hr>

                    <p style="
                        font-size: 12px;
                        color: #64748b;
                    ">
                        Manage email preferences:
                        <a href="${appUrl}/account">
                            Your account
                        </a>
                    </p>
                </div>
            `;

            try {
                await transporter.sendMail({
                    from: process.env.EMAIL_FROM,
                    to: recipient.email,
                    subject: campaign.subject,

                    text:
                        `${campaign.intro}\n\n` +
                        `${campaign.article_title || ''}\n` +
                        `${articleLink}\n\n` +
                        `Manage preferences: ${appUrl}/account`,

                    html: emailBody
                });

                db.prepare(`
                    INSERT INTO deliveries (
                        campaign_id,
                        user_id,
                        status,
                        error
                    )
                    VALUES (?, ?, 'sent', NULL)

                    ON CONFLICT(campaign_id, user_id)
                    DO UPDATE SET
                        status = 'sent',
                        error = NULL,
                        sent_at = CURRENT_TIMESTAMP
                `).run(id, recipient.id);
            } catch (error) {
                db.prepare(`
                    INSERT INTO deliveries (
                        campaign_id,
                        user_id,
                        status,
                        error
                    )
                    VALUES (?, ?, 'failed', ?)

                    ON CONFLICT(campaign_id, user_id)
                    DO UPDATE SET
                        status = 'failed',
                        error = excluded.error,
                        sent_at = CURRENT_TIMESTAMP
                `).run(
                    id,
                    recipient.id,
                    String(error.message).slice(0, 300)
                );
            }
        }

        const failures = db.prepare(`
            SELECT count(*) n
            FROM deliveries
            WHERE campaign_id = ?
              AND status = 'failed'
        `).get(id).n;

        const finalStatus =
            failures ? 'partial' : 'sent';

        db.prepare(`
            UPDATE campaigns
            SET
                status = ?,
                sent_at = CASE
                    WHEN ? = 'sent'
                    THEN CURRENT_TIMESTAMP
                    ELSE sent_at
                END
            WHERE id = ?
        `).run(
            finalStatus,
            finalStatus,
            id
        );

        return {
            recipients: recipients.length,
            failures
        };
    } finally {
        sending = false;
    }
}

// --------------------------------------------------
// Admin newsletter sending route
// --------------------------------------------------

app.post(
    '/admin/campaigns/:id/send',
    requireAdmin,
    async (req, res) => {
        try {
            const result = await sendCampaign(
                Number(req.params.id)
            );

            flash(
                req,
                `Campaign processed: ${result.recipients} eligible recipients, ${result.failures} failed. Review results below.`
            );
        } catch (error) {
            flash(
                req,
                'Send failed: ' + error.message
            );
        }

        res.redirect('/admin/campaigns');
    }
);

// --------------------------------------------------
// Automatic weekly newsletter scheduler
// --------------------------------------------------

if (
    process.env.ENABLE_SCHEDULED_SEND === 'true'
) {
    cron.schedule(
        process.env.NEWSLETTER_CRON || '0 9 * * 1',

        async () => {
            const week = new Date()
                .toISOString()
                .slice(0, 10);

            const key = `weekly-${week}`;

            const previousRun = db.prepare(`
                SELECT run_key
                FROM scheduled_runs
                WHERE run_key = ?
            `).get(key);

            if (previousRun) {
                return;
            }

            const campaign = db.prepare(`
                SELECT id
                FROM campaigns
                WHERE status = 'draft'
                ORDER BY created_at ASC
                LIMIT 1
            `).get();

            if (!campaign) {
                return;
            }

            db.prepare(`
                INSERT OR IGNORE INTO scheduled_runs (run_key)
                VALUES (?)
            `).run(key);

            try {
                await sendCampaign(campaign.id);
            } catch (error) {
                console.error(
                    'Scheduled email failure',
                    error
                );

                db.prepare(`
                    DELETE FROM scheduled_runs
                    WHERE run_key = ?
                `).run(key);
            }
        },

        {
            timezone:
                process.env.NEWSLETTER_TIMEZONE ||
                'Asia/Singapore'
        }
    );
}

// --------------------------------------------------
// 404 handler
// --------------------------------------------------

app.use((req, res) => {
    res.status(404).render('error', {
        title: 'Page not found',
        message: 'The page you requested could not be found.'
    });
});

// --------------------------------------------------
// Start application
// --------------------------------------------------

app.listen(port, () => {
    console.log(
        `THE WEEKLY running at ${appUrl} | ` +
        `Stripe ${stripeReady ? 'configured' : 'not configured'}`
    );
});
