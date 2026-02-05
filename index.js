const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const { Client, GatewayIntentBits } = require('discord.js');
const puppeteer = require('puppeteer');

console.log('Starting book-search-discord-bot...');

// Load credentials from config.json (create this file and add your token)
let config = { discordToken: '', prefix: '!' };
try {
	const cfg = fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8');
	Object.assign(config, JSON.parse(cfg));
} catch (e) {}

if (!config.discordToken) {
	console.log('Warning: no Discord token found in config.json. Add one before running.');
}

// Use only Guilds intent for slash commands (no Message Content required)
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildSearchUrl(base, query, type) {
	const b = base.replace(/\/$/, '');
	const encoded = encodeURIComponent(query).replace(/%20/g, '%20');
	// Template: [url]/browse/filter/t/[query]/k/[search type]/r/0xy
	return `${b}/browse/filter/t/${encoded}/k/${type}/r/0xy`;
}

async function scrapeStore(storeUrl, searchUrl) {
	try {
		console.log('Fetching', searchUrl);
		const res = await axios.get(searchUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } , timeout: 15000});
		console.log('Status', res.status, 'for', searchUrl);
		const $ = cheerio.load(res.data);
		const results = [];

		const anchors = $('a.nav');
		console.log('Found a.nav count:', anchors.length);

		anchors.each((i, el) => {
			const a = $(el);
			const title = a.find('h3 strong').first().text().trim();
			let itemUrl = a.attr('href') || '';
			try { itemUrl = new URL(itemUrl, storeUrl).href; } catch(e){/* leave as is */}
			const txt = a.text();
			const m = txt.match(/\$\s*[0-9]+(?:[\.,][0-9]{2})?/);
			const price = m ? m[0].replace(/\s+/g, '') : '';
			if (title || price || itemUrl) {
				results.push({ name: title, price, store: searchUrl, item: itemUrl });
			}
		});

		// fallback: if static parse found nothing, try a headless browser to render JS
		if (results.length === 0) {
			const items = $('div.listItem');
			console.log('Found div.listItem count:', items.length);
			if (items.length === 0) {
				console.log('No static items, launching puppeteer fallback...');
				try {
					const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
					const page = await browser.newPage();
					await page.setUserAgent('Mozilla/5.0');
					await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
					try {
						await page.waitForSelector('div.listItem, a.nav', { timeout: 7000 });
					} catch (e) {
						// selector may not appear
					}
					const scraped = await page.$$eval('a.nav', (nodes) => nodes.map(a => {
						const titleEl = a.querySelector('h3 strong');
						const title = titleEl ? titleEl.innerText.trim() : '';
						const text = a.innerText || '';
						const priceMatch = (text.match(/\$\s*[0-9]+(?:[\.,][0-9]{2})?/) || [null])[0] || '';
						return { title, price: priceMatch, href: a.href };
					}));
					if (scraped.length === 0) {
						const scraped2 = await page.$$eval('div.listItem', (nodes) => nodes.map(div => {
							const a = div.closest('a');
							const titleEl = div.querySelector('h3 strong');
							const title = titleEl ? titleEl.innerText.trim() : (a ? (a.querySelector('h3 strong') ? a.querySelector('h3 strong').innerText.trim() : '') : '');
							const text = div.innerText || (a ? a.innerText : '');
							const priceMatch = (text.match(/\$\s*[0-9]+(?:[\.,][0-9]{2})?/) || [null])[0] || '';
							return { title, price: priceMatch, href: a ? a.href : '' };
						}));
						scraped2.forEach(s => results.push({ name: s.title, price: s.price, store: searchUrl, item: s.href }));
					} else {
						scraped.forEach(s => results.push({ name: s.title, price: s.price, store: searchUrl, item: s.href }));
					}
					await browser.close();
				} catch (puErr) {
					console.warn('Puppeteer error for', searchUrl, puErr.message || puErr);
				}
			} else {
				items.each((i, el) => {
					const item = $(el);
					const a = item.closest('a');
					const title = item.find('h3 strong').first().text().trim() || a.find('h3 strong').first().text().trim();
					let itemUrl = a.attr('href') || '';
					try { itemUrl = new URL(itemUrl, storeUrl).href; } catch(e){}
					const txt = item.text() || a.text();
					const m = txt.match(/\$\s*[0-9]+(?:[\.,][0-9]{2})?/);
					const price = m ? m[0].replace(/\s+/g, '') : '';
					if (title || price || itemUrl) results.push({ name: title, price, store: searchUrl, item: itemUrl });
				});
			}
		}

		console.log('Extracted results count:', results.length, 'from', searchUrl);
		if (results.length === 0) {
			console.log('--- HTML snippet start ---');
			console.log(res.data.slice(0, 2000));
			console.log('--- HTML snippet end ---');
		}
		return results;
	} catch (err) {
		console.warn('Fetch error for', searchUrl, err.message || err);
		return { error: err.message };
	}
}

function readUrlList() {
	const csv = fs.readFileSync(path.join(__dirname, 'urlList.csv'), 'utf8');
	const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
	// skip header if present
	if (lines[0] && lines[0].toLowerCase().startsWith('url')) lines.shift();
	return lines;
}

// Perform searches sequentially (one URL at a time) and optionally send progress updates
async function performSearchAll(query, type, interaction = null) {
	const bases = readUrlList();
	const results = [];
	for (let i = 0; i < bases.length; i++) {
		const base = bases[i];
		const searchUrl = buildSearchUrl(base, query, type);
		try {
			if (interaction) {
				try { await interaction.editReply(`Searching ${i+1}/${bases.length}: ${base}`); } catch (e) { /* ignore edit errors */ }
			} else {
				console.log(`Searching ${i+1}/${bases.length}: ${base}`);
			}
			const scraped = await scrapeStore(base, searchUrl);
			const rows = Array.isArray(scraped) ? scraped : [];
			results.push(...rows);
		} catch (e) {
			console.warn('Error searching', base, String(e));
		}
		// optional small delay to be gentle with servers
		await new Promise(r => setTimeout(r, 500));
	}
	return results;
}

function writeCsv(rows) {
	const header = 'Book Name,Book Price,Store URL,Item Url\n';
	const lines = rows.map(r => {
		const esc = (s='') => '"' + String(s||'').replace(/"/g, '""') + '"';
		return [esc(r.name), esc(r.price), esc(r.store), esc(r.item)].join(',');
	});
	const out = header + lines.join('\n') + '\n';
	const fname = `results_${Date.now()}.csv`;
	fs.writeFileSync(path.join(__dirname, fname), out, 'utf8');
	return fname;
}

client.on('ready', async () => {
	console.log(`Logged in as ${client.user.tag}`);

	// Register slash command on startup. If `guildId` is provided in config, register to that guild (faster), otherwise register globally.
	const commands = [
		{
			name: 'search',
			description: 'Search all stores for a query',
			options: [
				{ name: 'query', description: 'Search query', type: 3, required: true },
				{ name: 'type', description: 'Search type', type: 3, required: false, choices: [ { name: 'keyword', value: 'keyword' }, { name: 'publisher', value: 'publisher' } ] }
			]
		}
	];

	try {
		if (config.guildId) {
			const guild = await client.guilds.fetch(config.guildId);
			await guild.commands.set(commands);
			console.log('Registered commands to guild', config.guildId);
		} else {
			await client.application.commands.set(commands);
			console.log('Registered global commands');
		}
	} catch (err) {
		console.warn('Failed to register slash commands:', err.message || err);
	}
});

client.on('interactionCreate', async (interaction) => {
	if (!interaction.isChatInputCommand()) return;
	if (interaction.commandName === 'search') {
		const query = interaction.options.getString('query');
		const type = interaction.options.getString('type') || 'keyword';
		// Defer reply once, then post progress into the channel (safe for long runs)
		await interaction.deferReply();
		// Edit the initial interaction reply once to confirm start
		try {
			await interaction.editReply('Search started — progress messages will appear in this channel.');
		} catch (e) {
			console.warn('Could not edit initial reply:', e && e.message ? e.message : e);
		}
		let statusMsg = null;
		try {
			const ch = await client.channels.fetch(interaction.channelId);
			statusMsg = await ch.send(`Starting search for "${query}" (type: ${type}) — 0/${readUrlList().length}`);
		} catch (e) {
			console.warn('Failed to create channel status message, will log to console instead:', e && e.message ? e.message : e);
		}
		try {
			const rows = await performSearchAll(query, type, statusMsg);
			if (!rows || rows.length === 0) {
				if (statusMsg) await statusMsg.edit('No results found.');
				return;
			}
			const fname = writeCsv(rows);
			// Send CSV as a normal channel message (uses bot token, not interaction webhook)
			if (statusMsg) {
				await statusMsg.edit(`Done — found ${rows.length} results. Attaching CSV...`);
				try { await statusMsg.channel.send({ content: `Found ${rows.length} results — CSV attached.`, files: [path.join(__dirname, fname)] }); } catch (e) { console.warn('Failed to send CSV via channel message:', e && e.message ? e.message : e); }
			} else {
				// as a fallback, try to follow up on the interaction (may fail if token expired)
				try { await interaction.followUp({ content: `Found ${rows.length} results; CSV attached.`, files: [path.join(__dirname, fname)] }); } catch (e) { console.warn('Failed to followUp on interaction:', e && e.message ? e.message : e); }
			}
		} catch (err) {
			console.error('Search failed:', err && err.message ? err.message : err);
			if (statusMsg) {
				try { await statusMsg.edit('Search failed: ' + String(err.message || err)); } catch (e) { }
			} else {
				try { await interaction.followUp('Search failed: ' + String(err.message || err)); } catch (e) { }
			}
		}
	}
});

// Debugging: show whether we'll attempt login
console.log('config.discordToken present:', Boolean(config.discordToken));
console.log('SKIP_DISCORD_LOGIN env:', Boolean(process.env.SKIP_DISCORD_LOGIN));
if (config.discordToken && !process.env.SKIP_DISCORD_LOGIN) {
	console.log('Attempting Discord login...');
	client.login(config.discordToken).catch(err => {
		console.error('Discord login failed:', err && err.message ? err.message : err);
		process.exitCode = 1;
	});
} else {
	if (!config.discordToken) console.log('Not logging in: no discordToken in config.json');
	if (process.env.SKIP_DISCORD_LOGIN) console.log('Not logging in: SKIP_DISCORD_LOGIN is set');
}

// Export for local testing
module.exports = { performSearchAll };
