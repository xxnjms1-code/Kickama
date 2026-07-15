const fs = require('fs');
const path = require('path');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK;
const SUBREDDITS = ['gamedev', 'Unity3D', 'unrealengine', 'indiegames'];
const KEYWORDS = ['cheater', 'hacker', 'anti-cheat', 'exploit', 'aimbot', 'wallhack'];

// Run every 6 hours, so we look for posts from the last 6 hours
const HOURS_TO_CHECK = 6; 
const TIME_LIMIT_SECONDS = Date.now() / 1000 - (HOURS_TO_CHECK * 60 * 60);

// Helper to sleep
const sleep = ms => new Promise(res => setTimeout(res, ms));

async function main() {
    if (!WEBHOOK_URL) {
        console.error("❌ DISCORD_WEBHOOK environment variable is not set!");
        process.exit(1);
    }

    console.log(`🤖 Starting Hermes Bot... scanning ${SUBREDDITS.length} subreddits for posts in the last ${HOURS_TO_CHECK} hours.`);

    let newLeads = 0;

    for (const sub of SUBREDDITS) {
        try {
            console.log(`📡 Scanning r/${sub}...`);
            const url = `https://www.reddit.com/r/${sub}/new.json?limit=25`;
            const response = await fetch(url, {
                headers: { 'User-Agent': 'Node:ggloop-hermes:v1.0.0 (by /u/ggloop)' }
            });

            if (!response.ok) {
                console.error(`Failed to fetch r/${sub}: ${response.statusText}`);
                continue;
            }

            const data = await response.json();
            const posts = data.data.children;

            for (const post of posts) {
                const p = post.data;
                
                // Skip posts older than our time window
                if (p.created_utc < TIME_LIMIT_SECONDS) {
                    continue;
                }

                const textToSearch = (p.title + " " + (p.selftext || "")).toLowerCase();
                
                const matchedKeywords = KEYWORDS.filter(kw => textToSearch.includes(kw));

                if (matchedKeywords.length > 0) {
                    console.log(`🚨 Hot Lead Found! [${matchedKeywords.join(', ')}] - ${p.title}`);
                    await sendToDiscord(p, matchedKeywords);
                    newLeads++;
                    // Rate limit discord webhooks
                    await sleep(2000);
                }
            }
            
            // Be nice to Reddit API
            await sleep(2000);

        } catch (err) {
            console.error(`Error processing r/${sub}:`, err.message);
        }
    }

    console.log(`✅ Hermes run complete. Found ${newLeads} new leads.`);
}

async function sendToDiscord(post, keywords) {
    const embed = {
        title: `🚨 Hot Lead in r/${post.subreddit}`,
        description: `**${post.title}**\n\n${post.selftext.substring(0, 300)}...`,
        url: `https://reddit.com${post.permalink}`,
        color: 0x5865F2, // Blurple
        fields: [
            { name: "Matched Keywords", value: keywords.join(', '), inline: true },
            { name: "Author", value: `u/${post.author}`, inline: true }
        ],
        footer: { text: "Hermes Bot • Reply with GG Loop SDK!" },
        timestamp: new Date(post.created_utc * 1000).toISOString()
    };

    await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] })
    });
}

main();
