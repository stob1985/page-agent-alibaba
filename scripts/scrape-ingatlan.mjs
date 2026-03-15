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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

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
	// XI. ker. - Sasad és Bartók Béla út környéke (felújítandó)
	'https://ingatlan.com/xi-ker/elado+lakas?allapot=felujitando',
	// XII. ker. (felújítandó)
	'https://ingatlan.com/xii-ker/elado+lakas?allapot=felujitando',
	// II. ker. (felújítandó)
	'https://ingatlan.com/ii-ker/elado+lakas?allapot=felujitando',
	// I. ker. (felújítandó)
	'https://ingatlan.com/i-ker/elado+lakas?allapot=felujitando',
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
	await page.waitForFunction(() => window.pageAgent !== undefined, { timeout: 10000 })

	// Átírjuk a konfigurációt a mi LLM API-nkkal
	await page.evaluate((config) => {
		// Dispose the demo agent
		if (window.pageAgent) {
			window.pageAgent.dispose()
		}

		// Create new agent with our config
		window.pageAgent = new window.PageAgent({
			model: config.model,
			apiKey: config.apiKey,
			baseURL: config.baseURL,
			language: 'hu',
		})

		console.log('🤖 page-agent újrainicializálva:', config.model)
	}, LLM_CONFIG)

	await randomDelay(500, 1000)
}

/**
 * Ingatlan adatok kinyerése egy listázó oldalról az AI agent segítségével
 */
async function extractListings(page, url) {
	console.log(`\n🔍 Oldal elemzése: ${url}`)

	const task = `
Elemezd az ingatlan.com listázó oldalt és keresd ki az összes lakás hirdetést.

Keresési feltételek:
- Maximum ár: 120 millió Ft (120 000 000 Ft)
- Maximum négyzetméterár: 1,4 millió Ft/nm
- Emelet: 1. emelet vagy magasabb. HA 2. emelet vagy magasabb, AKKOR csak liftes épület!
- Nézetirány: utcai, kertre néző, vagy panorámás
- Épület állapota: jó (nem rossz)
- Épület kora: 1950 előtt VAGY 1980 után épült
- Fűtés: bármilyen
- Lakás állapota: befejezetlen VAGY felújítandó

Utasítások:
1. Görgess végig az összes hirdetésen az oldalon
2. Minden egyes hirdetésnél nézd meg: ár, méret, négyzetméterár, cím, emelet, lift, tájolás, épület kora, állapot
3. Szűrd ki azokat amelyek NEM felelnek meg a feltételeknek
4. Gyűjtsd össze az összes megfelelő hirdetést

Válaszolj KIZÁRÓLAG valid JSON tömbként, a következő formátumban (semmi más szöveg):
[
  {
    "cim": "...",
    "ar_ft": 95000000,
    "meret_nm": 65,
    "ar_per_nm": 1461538,
    "emelet": "2",
    "lift": true,
    "tajolas": "utcai",
    "epulet_eve": 1935,
    "allapot": "felújítandó",
    "url": "https://ingatlan.com/...",
    "megfelel": true,
    "nem_megfelel_oka": ""
  }
]

Ha nem találsz megfelelő ingatlant, adj vissza üres tömböt: []
`

	try {
		const result = await page.evaluate(async (taskText) => {
			return await window.pageAgent.execute(taskText)
		}, task)

		if (result.success && result.data) {
			try {
				// Parse JSON from result
				const jsonMatch = result.data.match(/\[[\s\S]*\]/)
				if (jsonMatch) {
					const listings = JSON.parse(jsonMatch[0])
					console.log(`  ✅ ${listings.length} ingatlan találva`)
					return listings
				}
			} catch (e) {
				console.log(`  ⚠️  JSON parse hiba, nyers adat:`, result.data.substring(0, 200))
			}
		} else {
			console.log(`  ❌ Agent hiba:`, result.data)
		}
	} catch (e) {
		console.error(`  ❌ Kritikus hiba:`, e.message)
	}

	return []
}

/**
 * Egy URL scrapelése (több lappal)
 */
async function scrapeUrl(browser, url, allResults) {
	const context = await browser.newContext({
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
	let currentUrl = url

	try {
		while (pageNum <= 5) {
			// Max 5 oldal per keresés
			console.log(`  📄 ${pageNum}. oldal betöltése...`)

			// Emberi viselkedés: véletlenszerű késleltetés oldaltöltések között
			if (pageNum > 1) {
				await randomDelay(3000, 7000)
			}

			await page.goto(currentUrl, {
				waitUntil: 'domcontentloaded',
				timeout: 30000,
			})

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

			// page-agent inicializálása
			await initPageAgent(page)

			// Adatok kinyerése az AI agent segítségével
			const listings = await extractListings(page, currentUrl)

			// Szűrt eredmények hozzáadása
			const matching = listings.filter((l) => l.megfelel !== false)
			allResults.push(...matching)
			console.log(
				`  📊 ${matching.length} megfelelő ingatlan hozzáadva (${allResults.length} összesen)`
			)

			// Következő oldal keresése
			const nextPage = await page.$(
				'a[rel="next"], .pagination__next, [data-testid="pagination-next"]'
			)
			if (!nextPage) {
				console.log('  ✅ Nincs több oldal')
				break
			}

			const nextHref = await nextPage.getAttribute('href')
			if (!nextHref) break

			currentUrl = nextHref.startsWith('http') ? nextHref : `https://ingatlan.com${nextHref}`
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

	const browser = await chromium.launch({
		executablePath: '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome',
		headless: true, // true a szerver környezetben; false ha látni akarod
		args: [
			'--no-sandbox',
			'--disable-setuid-sandbox',
			'--disable-blink-features=AutomationControlled', // Fontos: elrejti az automatizálás jeleit
			'--disable-web-security',
			'--disable-features=IsolateOrigins,site-per-process',
			'--window-size=1366,768',
		],
	})

	const allResults = []

	try {
		for (let i = 0; i < SEARCH_URLS.length; i++) {
			const url = SEARCH_URLS[i]
			const district = url.match(/\/([-a-z]+)-ker\//)?.[1]?.toUpperCase() || `URL ${i + 1}`
			console.log(`\n${'='.repeat(50)}`)
			console.log(`🏙️  ${district}. kerület scrapelése...`)
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
	}

	// Eredmények deduplikálása URL alapján
	const seen = new Set()
	const unique = allResults.filter((r) => {
		if (!r.url || seen.has(r.url)) return false
		seen.add(r.url)
		return true
	})

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
