/**
 * Ingatlan.com scraper - Page Agent alapú
 *
 * Playwright + page-agent IIFE kombinációja:
 * - Playwright nyitja a böngészőt (emberi viselkedés szimulálásával)
 * - page-agent fut a böngészőben és AI-val elemzi az oldalakat
 * - Az agent kinyeri az ingatlan adatokat strukturált JSON formában
 *
 * Használat:
 *   LLM_API_KEY=xxx LLM_MODEL_NAME=gpt-4o LLM_BASE_URL=https://api.openai.com/v1 node scripts/scrape-ingatlan.mjs
 *
 * Ha nincs LLM config, az ingyenes demo API-t használja.
 */
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { chromium } from 'playwright'
import { fileURLToPath } from 'url'

import { BRIDGE_HOST, BRIDGE_PORT, startBridge } from './proxy-bridge.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

// --- User proxy (megvásárolt residential proxy) ---
// Beállítható env változóval is: USER_PROXY_URL=http://user:pass@host:port
const USER_PROXY_URL =
	process.env.USER_PROXY_URL || 'http://obccpvrt:8g01793iry4x@31.59.20.176:6754'

// --- Keresési feltételek ---
const CRITERIA = {
	maxPrice: 120_000_000, // 120M Ft
	maxPricePerSqm: 1_400_000, // 1.4M Ft/nm
	// emelet: 1+ de ha 2+ akkor csak liftes
	// épület: 1950 előtt vagy 1980 után
	// kilátás: utcai / kertre néző / panorámás
	// állapot: befejezetlen vagy felújítandó
}

// --- Keresési URL-ek ---
const SEARCH_URLS = [
	'https://ingatlan.com/lista/elado+lakas+felujitando+1-2-emelet+120-mFt-ig+panoramas+utcai-kilatas+kertre-nezo+i-ker+ii-ker+xi-ker+xii-ker',
]

// --- LLM konfiguráció ---
// Prioritás: .env fájl > környezeti változók > ingyenes demo API
let LLM_CONFIG = null

const envPath = join(ROOT, '.env')
if (existsSync(envPath)) {
	const envContent = readFileSync(envPath, 'utf8')
	const envVars = {}
	for (const line of envContent.split('\n')) {
		const match = line.match(/^([A-Z_]+)\s*=\s*["']?(.+?)["']?\s*$/)
		if (match) envVars[match[1]] = match[2]
	}
	if (envVars.LLM_API_KEY && envVars.LLM_API_KEY !== 'your-api-key') {
		LLM_CONFIG = {
			model: envVars.LLM_MODEL_NAME || 'gpt-4o',
			apiKey: envVars.LLM_API_KEY,
			baseURL: envVars.LLM_BASE_URL || 'https://api.openai.com/v1',
		}
		console.log(`✅ LLM config betöltve .env-ből: ${LLM_CONFIG.model}`)
	}
}

if (!LLM_CONFIG && process.env.LLM_API_KEY) {
	LLM_CONFIG = {
		model: process.env.LLM_MODEL_NAME || 'gpt-4o',
		apiKey: process.env.LLM_API_KEY,
		baseURL: process.env.LLM_BASE_URL || 'https://api.openai.com/v1',
	}
	console.log(`✅ LLM config betöltve env változókból: ${LLM_CONFIG.model}`)
}

if (!LLM_CONFIG) {
	console.log(
		'ℹ️  LLM config nem található, ingyenes demo API-t használok (ingatlan.com/xi-ker stb.)'
	)
	LLM_CONFIG = {
		model: 'qwen3.5-plus',
		apiKey: 'NA',
		baseURL: 'https://page-ag-testing-ohftxirgbn.cn-shanghai.fcapp.run',
	}
}

// --- Page-agent IIFE betöltése ---
const iifePath = join(ROOT, 'packages/page-agent/dist/iife/page-agent.demo.js')
if (!existsSync(iifePath)) {
	console.error('❌ page-agent IIFE nem található. Futtasd: npm run build:libs')
	process.exit(1)
}
const pageAgentScript = readFileSync(iifePath, 'utf8')

// --- Emberi viselkedés szimulálása ---
const randomDelay = (min = 800, max = 2500) =>
	new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)))

const randomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min

/**
 * Emberi scroll szimulálása
 */
async function humanScroll(page) {
	const scrolls = randomInt(2, 5)
	for (let i = 0; i < scrolls; i++) {
		await page.mouse.wheel(0, randomInt(200, 600))
		await randomDelay(300, 800)
	}
}

/**
 * Emberi egérmozgás szimulálása
 */
async function humanMouseMove(page) {
	const x = randomInt(200, 1000)
	const y = randomInt(200, 600)
	await page.mouse.move(x, y, { steps: randomInt(5, 20) })
}

/**
 * page-agent inicializálása az oldalon
 */
async function initPageAgent(page) {
	// Először futtatjuk a page-agent IIFE-t (ami a demo konfiggal indul)
	await page.evaluate((script) => {
		const el = document.createElement('script')
		el.text = script
		document.head.appendChild(el)
	}, pageAgentScript)

	// Várunk amíg inicializálódik
	await page
		.waitForFunction(() => window.pageAgent !== undefined, { timeout: 10000 })
		.catch((e) => {
			throw new Error(`page-agent init sikertelen: ${e.message}`)
		})

	// Átírjuk a konfigurációt a mi LLM API-nkkal.
	// customTools: a kattintás-eszközöket letiltjuk, hogy az agent ne navigáljon el az oldalról.
	// instructions.system: rendszerszintű utasítás az agent számára.
	await page.evaluate((config) => {
		if (window.pageAgent) {
			window.pageAgent.dispose()
		}

		window.pageAgent = new window.PageAgent({
			model: config.model,
			apiKey: config.apiKey,
			baseURL: config.baseURL,
			language: 'hu',
			// Letiltjuk az interakciós eszközöket: csak scroll + done marad
			customTools: {
				click_element_by_index: null,
				input_text: null,
				select_dropdown_option: null,
			},
			instructions: {
				system:
					'You are a data extraction agent. Your ONLY job is to read the current page and extract listing data. Do NOT navigate away from this page. Do NOT click any links. Only use scroll to see more content, then call done with the extracted JSON.',
			},
		})

		console.log('🤖 page-agent inicializálva (csak scroll+done):', config.model)
	}, LLM_CONFIG)

	await randomDelay(500, 1000)
}

/**
 * Magyar számformátum értelmezése (pl. "45 000 000", "45M", "45,5 M")
 */
function parseHunPrice(str) {
	if (!str) return null
	const s = str.replace(/\s/g, '').replace(',', '.')
	// "45M" vagy "45.5M" → millió forint
	const mMatch = s.match(/([\d.]+)\s*[Mm]/)
	if (mMatch) return Math.round(parseFloat(mMatch[1]) * 1_000_000)
	// sima szám
	const num = parseFloat(s.replace(/[^\d.]/g, ''))
	return isNaN(num) ? null : Math.round(num)
}

function parseHunSize(str) {
	if (!str) return null
	const s = str.replace(/\s/g, '').replace(',', '.')
	const num = parseFloat(s.replace(/[^\d.]/g, ''))
	return isNaN(num) || num === 0 ? null : Math.round(num)
}

/**
 * Ingatlan adatok kinyerése DOM-ból közvetlenül (AI-mentes, megbízható)
 */
async function extractListings(page, url) {
	console.log(`\n🔍 Oldal elemzése (DOM): ${url}`)

	// Görgetés hogy minden kártya betöltsön (lazy load)
	await page.evaluate(async () => {
		for (let i = 0; i < 5; i++) {
			window.scrollBy(0, window.innerHeight)
			await new Promise((r) => setTimeout(r, 600))
		}
		window.scrollTo(0, 0)
	})
	await randomDelay(800, 1500)

	// Debug: HTML struktúra ellenőrzése
	const pageInfo = await page.evaluate(() => {
		const counts = {
			articles: document.querySelectorAll('article').length,
			cards: document.querySelectorAll('[class*="card"]').length,
			listings: document.querySelectorAll('[class*="listing"]').length,
			liElements: document.querySelectorAll('ul li').length,
		}
		// JSON-LD keresése
		const jsonLds = Array.from(document.querySelectorAll('script[type="application/ld+json"]')).map(
			(s) => s.textContent.substring(0, 100)
		)
		// window.__INITIAL_STATE__ keresése
		const hasInitState = typeof window.__INITIAL_STATE__ !== 'undefined'
		const hasNextData = typeof window.__NEXT_DATA__ !== 'undefined'
		// body class
		const bodyClass = document.body.className.substring(0, 100)
		return { counts, jsonLds: jsonLds.slice(0, 3), hasInitState, hasNextData, bodyClass }
	})
	console.log(`  📐 Oldal struktúra:`, JSON.stringify(pageInfo.counts))
	console.log(`  📐 JSON-LD:`, pageInfo.jsonLds)
	console.log(`  📐 Body class:`, pageInfo.bodyClass)
	if (pageInfo.hasNextData) console.log(`  ✅ __NEXT_DATA__ megtalálva`)
	if (pageInfo.hasInitState) console.log(`  ✅ __INITIAL_STATE__ megtalálva`)

	// DEBUG: HTML dump — hogy lássuk az ingatlan.com struktúráját
	{
		const htmlDump = await page.evaluate(() => document.body?.innerHTML?.substring(0, 10000) || '')
		const dumpPath = join(ROOT, 'debug-page-dump.html')
		if (!existsSync(dumpPath)) {
			writeFileSync(dumpPath, htmlDump, 'utf8')
			console.log(`  💾 HTML dump mentve: ${dumpPath}`)
		}
	}

	// 1. kísérlet: Next.js __NEXT_DATA__ (legmegbízhatóbb)
	const nextDataListings = await page.evaluate(() => {
		try {
			if (!window.__NEXT_DATA__) return null
			const data = window.__NEXT_DATA__
			// Keressük a hirdetés listát mélyen a pageProps-ban
			const search = (obj, depth = 0) => {
				if (depth > 8 || !obj || typeof obj !== 'object') return null
				if (
					Array.isArray(obj) &&
					obj.length > 0 &&
					obj[0]?.id &&
					(obj[0]?.price || obj[0]?.listingId || obj[0]?.listing_id)
				)
					return obj
				for (const key of Object.keys(obj)) {
					if (
						['listings', 'results', 'items', 'cards', 'properties'].includes(key) &&
						Array.isArray(obj[key]) &&
						obj[key].length > 0
					) {
						return obj[key]
					}
					const found = search(obj[key], depth + 1)
					if (found) return found
				}
				return null
			}
			return search(data)
		} catch (e) {
			return null
		}
	})

	if (nextDataListings && nextDataListings.length > 0) {
		console.log(`  ✅ Next.js adatból ${nextDataListings.length} hirdetés`)
		// Normalizáljuk az adatokat
		return nextDataListings
			.map((item) => {
				const price = item.price?.value || item.price || item.listingPrice || null
				const size = item.area || item.size || item.floorArea || null
				const arPrNm = price && size ? Math.round(price / size) : null
				return {
					cim: item.title || item.address || item.street || '',
					ar_ft: price,
					meret_nm: size,
					ar_per_nm: item.pricePerMeter || item.unitPrice || arPrNm,
					url: item.url || item.link || (item.id ? `https://ingatlan.com/${item.id}` : null),
					_forrás: 'next_data',
				}
			})
			.filter((i) => i.url)
	}

	// 2. kísérlet: JSON-LD structured data
	const jsonLdListings = await page.evaluate(() => {
		try {
			const scripts = document.querySelectorAll('script[type="application/ld+json"]')
			for (const s of scripts) {
				const data = JSON.parse(s.textContent)
				if (data['@type'] === 'ItemList' && data.itemListElement) {
					return data.itemListElement.map((item) => ({
						cim: item.name || item.item?.name || '',
						ar_ft: item.item?.offers?.price || null,
						meret_nm: null,
						ar_per_nm: null,
						url: item.url || item.item?.url || null,
						_forrás: 'json_ld',
					}))
				}
			}
		} catch (_) {}
		return null
	})

	if (jsonLdListings && jsonLdListings.length > 0) {
		console.log(`  ✅ JSON-LD-ből ${jsonLdListings.length} hirdetés`)
		return jsonLdListings.filter((i) => i.url)
	}

	// 3. kísérlet: DOM scraping — ingatlan.com kártya elemek
	const domListings = await page.evaluate(() => {
		const results = []

		// Különböző szelektorok az ingatlan.com különböző verzióihoz
		const cardSelectors = [
			'article.listing-card',
			'article[data-id]',
			'[data-testid="listing-card"]',
			'.listing-card',
			'.property-card',
			'[class*="ListingCard"]',
			'[class*="listing-card"]',
			'[class*="PropertyCard"]',
		]

		let cards = []
		for (const sel of cardSelectors) {
			const found = document.querySelectorAll(sel)
			if (found.length > 0) {
				cards = Array.from(found)
				break
			}
		}

		// Ha nem sikerült kártyákat találni, próbáljuk az article elemeket
		if (cards.length === 0) {
			cards = Array.from(document.querySelectorAll('article')).filter(
				(a) => a.querySelector('a[href*="/"]') && a.textContent.includes('Ft')
			)
		}

		for (const card of cards) {
			// URL
			const linkEl = card.querySelector('a[href*="ingatlan.com"], a[href^="/"]')
			const href = linkEl?.getAttribute('href') || ''
			const url = href.startsWith('http') ? href : href ? `https://ingatlan.com${href}` : null
			if (!url) continue

			// Cím
			const cimEl = card.querySelector(
				'h2, h3, [class*="title"], [class*="address"], [class*="cim"]'
			)
			const cim = cimEl?.textContent?.trim() || ''

			// Az összes szöveget megkapjuk a kártyából
			const szoveg = card.textContent || ''

			// Ár (Ft) — különböző formátumok
			let ar_ft = null
			const arEl = card.querySelector('[class*="price"], [class*="ar"], [class*="Price"]')
			const arSzoveg = arEl?.textContent || szoveg
			const arMatch =
				arSzoveg.match(/([\d\s]+(?:[,.][\d]+)?)\s*(?:M\s*Ft|millió\s*Ft|mFt)/i) ||
				arSzoveg.match(/([\d\s]{5,})\s*Ft/)
			if (arMatch) {
				const raw = arMatch[1].replace(/\s/g, '').replace(',', '.')
				const num = parseFloat(raw)
				if (!isNaN(num)) {
					// Ha "M Ft" → szorozzuk millióval
					ar_ft = arMatch[0].toLowerCase().includes('m')
						? Math.round(num * 1_000_000)
						: Math.round(num)
				}
			}

			// Méret (nm / m²)
			let meret_nm = null
			const meretMatch = szoveg.match(/([\d]+(?:[,.][\d]+)?)\s*(?:m²|nm|m2)/i)
			if (meretMatch) {
				meret_nm = Math.round(parseFloat(meretMatch[1].replace(',', '.')))
			}

			// Ár/nm
			let ar_per_nm = null
			const arNmMatch = szoveg.match(/([\d\s]+(?:[,.][\d]+)?)\s*(?:Ft\/nm|Ft\/m²|ezer\s*Ft\/nm)/i)
			if (arNmMatch) {
				const raw = arNmMatch[1].replace(/\s/g, '').replace(',', '.')
				const num = parseFloat(raw)
				if (!isNaN(num)) {
					ar_per_nm = arNmMatch[0].toLowerCase().includes('ezer')
						? Math.round(num * 1000)
						: Math.round(num)
				}
			}
			// Ha nincs explicite megadva, kiszámoljuk
			if (!ar_per_nm && ar_ft && meret_nm) {
				ar_per_nm = Math.round(ar_ft / meret_nm)
			}

			results.push({ cim, ar_ft, meret_nm, ar_per_nm, url, _forrás: 'dom' })
		}

		return results
	})

	if (domListings && domListings.length > 0) {
		console.log(`  ✅ DOM-ból ${domListings.length} hirdetés kinyerve`)
		return domListings
	}

	// 4. kísérlet: page-agent AI fallback (ha DOM sem működött)
	console.log(`  ⚠️  DOM üres, page-agent fallback...`)
	try {
		await initPageAgent(page)
		const result = await page.evaluate(async () => {
			return await window.pageAgent.execute(
				'List ALL property listings on this page as JSON array: [{cim, ar_ft (number), meret_nm (number), ar_per_nm (number), url}]. Return ONLY the JSON array, nothing else.'
			)
		})
		if (result.success && result.data) {
			const jsonMatch = result.data.match(/\[[\s\S]*\]/)
			if (jsonMatch) {
				const listings = JSON.parse(jsonMatch[0])
				console.log(`  ✅ AI fallback: ${listings.length} hirdetés`)
				return listings
			}
		}
	} catch (e) {
		console.error(`  ❌ AI fallback hiba:`, e.message)
	}

	console.log(`  ❌ Nincs hirdetés kinyerve ezen az oldalon`)
	return []
}

/**
 * Egy URL scrapelése (több lappal)
 */
async function scrapeUrl(browser, url, allResults) {
	const context = await browser.newContext({
		// Proxy SSL intercept miatt szükséges
		ignoreHTTPSErrors: true,
		// Valódi böngésző user agent
		userAgent:
			'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
		viewport: { width: 1366, height: 768 },
		locale: 'hu-HU',
		timezoneId: 'Europe/Budapest',
		geolocation: { longitude: 19.0402, latitude: 47.4979 }, // Budapest
		permissions: ['geolocation'],
	})

	const page = await context.newPage()

	// Fejléc beállítása hogy valódi látogatónak tűnjön
	await page.setExtraHTTPHeaders({
		'Accept-Language': 'hu-HU,hu;q=0.9,en-US;q=0.8,en;q=0.7',
		Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
		'Accept-Encoding': 'gzip, deflate, br',
		Connection: 'keep-alive',
		'Upgrade-Insecure-Requests': '1',
	})

	let pageNum = 1

	// Alap URL lapszám nélkül (eltávolítjuk ha már van ?page= a végén)
	const baseUrl = url.replace(/[?&]page=\d+/, '')

	try {
		while (pageNum <= 10) {
			// Max 10 oldal (~200 hirdetés)
			const currentUrl = pageNum === 1 ? baseUrl : `${baseUrl}?page=${pageNum}`
			console.log(`  📄 ${pageNum}. oldal betöltése...`)

			// Emberi viselkedés: véletlenszerű késleltetés oldaltöltések között
			if (pageNum > 1) {
				await randomDelay(3000, 7000)
			}

			await page.goto(currentUrl, {
				waitUntil: 'load',
				timeout: 45000,
			})

			// Várunk amíg a hálózat lecsendesedik (JS átirányítások leállnak)
			try {
				await page.waitForLoadState('networkidle', { timeout: 8000 })
			} catch (_) {
				// networkidle timeout nem végzetes
			}

			// Ellenőrzés: az oldal az ingatlan.com-on van-e még?
			const finalUrl = page.url()
			if (!finalUrl.includes('ingatlan.com')) {
				console.log(`  ⚠️  Átirányítás: ${finalUrl} — kihagyva`)
				break
			}
			console.log(`  🌐 Betöltött URL: ${finalUrl}`)

			// Várunk a tartalom betöltésére
			await randomDelay(1500, 3000)

			// Cookie elfogadás ha megjelenik
			try {
				const cookieBtn = await page.$(
					'button[data-testid="cookie-accept"], .cookie-accept, #CybotCookiebotDialogBodyButtonAccept'
				)
				if (cookieBtn) {
					await cookieBtn.click()
					await randomDelay(500, 1000)
					console.log('  🍪 Cookie elfogadva')
				}
			} catch (_) {}

			// Emberi scroll szimulálása
			await humanMouseMove(page)
			await humanScroll(page)

			// Adatok kinyerése DOM-ból (AI csak fallback)
			const listings = await extractListings(page, currentUrl)

			if (listings.length === 0) {
				console.log('  ✅ Üres oldal — lapozás vége')
				break
			}

			// Csak tájékoztató log: mennyit szűr ki
			const matching = listings.filter(
				(l) => l.ar_per_nm && Number(l.ar_per_nm) <= CRITERIA.maxPricePerSqm
			)
			allResults.push(...listings) // összes eltároljuk, szűrés a végén
			console.log(
				`  📊 ${listings.length} hirdetés kinyerve, ebből ${matching.length} megfelelő (összesen eddig: ${allResults.length})`
			)

			// Lapozás vége ellenőrzés:
			// 1. Ha az URL visszaállt az 1. oldalra (az oldal nem fogadja a ?page=N paramétert)
			if (pageNum > 1) {
				const finalUrlObj = new URL(finalUrl)
				const returnedPage = finalUrlObj.searchParams.get('page')
				if (!returnedPage || returnedPage !== String(pageNum)) {
					console.log(`  ✅ Nincs több oldal (URL nem tartalmazza: page=${pageNum})`)
					break
				}
			}

			// 2. DOM-ban sincs "következő" gomb/link
			const hasNextPage = await page.evaluate((nextPageNum) => {
				const selectors = [
					'a[rel="next"]',
					'[data-testid="pagination-next"]',
					'.pagination__next',
					'a.next',
				]
				for (const sel of selectors) {
					const el = document.querySelector(sel)
					if (el && !el.hasAttribute('disabled') && el.tagName !== 'SPAN') return true
				}
				// Keres olyan linket ami a következő lapszámra mutat
				const allLinks = document.querySelectorAll('a[href]')
				for (const link of allLinks) {
					if (link.getAttribute('href')?.includes(`page=${nextPageNum}`)) return true
				}
				return false
			}, pageNum + 1)

			if (!hasNextPage) {
				console.log('  ✅ Nincs több oldal')
				break
			}

			pageNum++

			// Hosszabb szünet oldalak között (emberi viselkedés)
			await randomDelay(4000, 9000)
		}
	} catch (e) {
		console.error(`  ❌ Hiba az oldal scrapelése során: ${e.message}`)
	} finally {
		await context.close()
	}
}

/**
 * Fő belépési pont
 */
async function main() {
	console.log('🏠 Ingatlan.com Scraper - Page Agent alapú')
	console.log('==========================================')
	console.log(
		`📋 Feltételek: max ${CRITERIA.maxPrice / 1e6}M Ft, max ${CRITERIA.maxPricePerSqm / 1e6}M Ft/nm`
	)
	console.log(`🔗 ${SEARCH_URLS.length} keresési URL feldolgozása\n`)

	// Proxy híd indítása: localhost → Anthropic proxy → user proxy → ingatlan.com
	let bridgeServer = null
	let proxyConfig = undefined

	if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) {
		try {
			bridgeServer = await startBridge(USER_PROXY_URL)
			proxyConfig = { server: `http://${BRIDGE_HOST}:${BRIDGE_PORT}` }
			console.log(
				`🔌 Proxy lánc: Playwright → localhost:${BRIDGE_PORT} → user proxy → ingatlan.com`
			)
		} catch (e) {
			console.log(`⚠️  Proxy híd hiba: ${e.message}, proxy nélkül próbálkozom`)
		}
	}

	const browser = await chromium.launch({
		headless: true,
		proxy: proxyConfig,
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-blink-features=AutomationControlled',
			'--disable-features=IsolateOrigins,site-per-process',
			'--window-size=1366,768',
		],
	})

	const allResults = []

	try {
		for (let i = 0; i < SEARCH_URLS.length; i++) {
			const url = SEARCH_URLS[i]
			console.log(`\n${'='.repeat(50)}`)
			console.log(`🔍 Keresés ${i + 1}/${SEARCH_URLS.length}`)
			console.log('='.repeat(50))

			await scrapeUrl(browser, url, allResults)

			// Hosszabb szünet kerületek között
			if (i < SEARCH_URLS.length - 1) {
				const wait = randomInt(8000, 15000)
				console.log(`\n⏳ ${wait / 1000}s szünet a következő kerület előtt...`)
				await new Promise((r) => setTimeout(r, wait))
			}
		}
	} finally {
		await browser.close()
		if (bridgeServer) bridgeServer.close()
	}

	// Eredmények deduplikálása URL alapján
	const seen = new Set()
	const uniqueAll = allResults.filter((r) => {
		if (!r.url || seen.has(r.url)) return false
		seen.add(r.url)
		return true
	})

	// ar_per_nm pótlása ha hiányzik (ár / méret kiszámolva)
	for (const l of uniqueAll) {
		if (!l.ar_per_nm && l.ar_ft && l.meret_nm) {
			l.ar_per_nm = Math.round(l.ar_ft / l.meret_nm)
		}
	}

	// Szűrés: CSAK azok maradnak ahol ar_per_nm ISMERT és <= 1.4M Ft/nm
	// (ha nincs ár/nm adat, kizárjuk — nem engedünk át ismeretlen drágákat)
	const unique = uniqueAll.filter(
		(l) => l.ar_per_nm && Number(l.ar_per_nm) <= CRITERIA.maxPricePerSqm
	)

	console.log(`\n📋 Összes kinyert hirdetés: ${uniqueAll.length} db`)
	console.log(`🔍 1.4M Ft/nm alatti szűrés után: ${unique.length} db`)

	// Ár szerint rendezve
	unique.sort((a, b) => (a.ar_ft || 0) - (b.ar_ft || 0))

	// Eredmények mentése
	const outputPath = join(ROOT, 'ingatlan-eredmenyek.json')
	writeFileSync(outputPath, JSON.stringify(unique, null, 2), 'utf8')

	// Összefoglalás
	console.log('\n' + '='.repeat(50))
	console.log('📊 EREDMÉNYEK ÖSSZEFOGLALÓJA')
	console.log('='.repeat(50))
	console.log(`✅ Talált megfelelő ingatlanok: ${unique.length} db`)
	console.log(`💾 Mentve: ${outputPath}`)

	if (unique.length > 0) {
		console.log('\n🏆 Top 5 legjobb ár szerint:')
		unique.slice(0, 5).forEach((p, i) => {
			const ar = p.ar_ft ? `${(p.ar_ft / 1e6).toFixed(1)}M Ft` : '?'
			const nm = p.meret_nm ? `${p.meret_nm}nm` : '?'
			const arNm = p.ar_per_nm ? `${(p.ar_per_nm / 1e6).toFixed(2)}M/nm` : '?'
			console.log(`  ${i + 1}. ${p.cim} | ${ar} | ${nm} | ${arNm}`)
			if (p.url) console.log(`     🔗 ${p.url}`)
		})
	}

	return unique
}

main().catch((e) => {
	console.error('❌ Végzetes hiba:', e)
	process.exit(1)
})
