'use strict';
/** First-run admin bootstrap and optional sample articles. */
const bcrypt = require('bcryptjs');
const db = require('./db');
const adminEmail = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const adminPassword = process.env.ADMIN_PASSWORD || '';
if (adminEmail && adminPassword) {
    if (adminPassword.length < 12) {
        throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
    }
    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
    if (!exists) {
        db.prepare(`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (?, ?, ?, 'admin')
    `).run(adminEmail, bcrypt.hashSync(adminPassword, 12), 'Editor');
        console.log(`Admin account created: ${adminEmail}`);
    }
}
const articleCount = db.prepare('SELECT COUNT(*) AS count FROM articles').get().count;
if (articleCount === 0 && process.env.SEED_DEMO_ARTICLES !== 'false') {
    const articles = [
        {
            slug: 'quiet-signals-market-rally',
            title: 'The Quiet Signals Beneath the Market Rally',
            category: 'Macro',
            excerpt: 'When markets climb in unison, the most important message may come from the assets refusing to follow.',
            body: `A rising index tells only part of the story. Under the surface, breadth, bond yields and currency movements may be sending different signals.

## Beyond the headline

Major indices can mask a narrowing group of leaders. Watching only the headline level may obscure the drivers beneath the rally.

## What we are watching

An illustrative watchlist might track Treasury yields, volatility, equity breadth and the dollar. Each adds context, not certainty.

*Demonstration editorial copy — not investment advice.*`,
        },
        {
            slug: 'dollar-rates-turning-point',
            title: 'The Dollar, Rates and the Next Turning Point',
            category: 'Currencies',
            excerpt: 'Currency markets sometimes reveal uncomfortable truths before equity investors are ready to listen.',
            body: `The dollar sits at the intersection of monetary policy, funding conditions and global trade.

## Reading the cross-currents

Interest-rate expectations matter, but so do relative growth, liquidity and positioning. A familiar narrative may already be priced in.

## Three questions

Where are real yields going? What is happening to credit conditions? And which markets react first when assumptions change?

*Demonstration editorial copy — not investment advice.*`,
        },
        {
            slug: 'asia-markets-opportunity',
            title: 'Asia Markets: Opportunity or Optical Illusion?',
            category: 'Asia Pacific',
            excerpt: 'From Tokyo to Sydney, divergence is becoming the defining feature of the market conversation.',
            body: `Asia Pacific markets are not a single trade. Domestic policy, currencies and export exposure change the picture dramatically.

## Different markets, different stories

Regional summaries can miss the interplay between commodity demand, monetary policy and company fundamentals.

## A skeptical perspective

The useful question is whether prices adequately compensate investors for their risks, not whether a market can rise.

*Demonstration editorial copy — not investment advice.*`,
        },
        {
            slug: 'bond-markets-last-word',
            title: 'Why Bond Markets Deserve the Last Word',
            category: 'Fixed Income',
            excerpt: 'The bond market may not be loud, but it rarely stays silent for long.',
            body: `Bond yields reflect changing assumptions about inflation, growth and government financing.

## Watching the curve

Yield curve changes can have multiple explanations. Context is essential.

## The investor’s dilemma

Chasing a single narrative is tempting. Testing competing explanations is more useful.

*Demonstration editorial copy — not investment advice.*`,
        },
    ];
    const insert = db.prepare(`
    INSERT INTO articles (
      slug, title, category, excerpt, body, author, status, featured, published_at
    ) VALUES (?, ?, ?, ?, ?, 'The Weekly', 'published', ?, datetime('now', ?))
  `);
    articles.forEach((article, index) => {
        insert.run(article.slug, article.title, article.category, article.excerpt, article.body, index === 0 ? 1 : 0, `-${index * 3} days`);
    });
}
