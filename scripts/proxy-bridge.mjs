/**
 * Proxy bridge: localhost:9090 → Anthropic proxy → user proxy → target
 *
 * Szükséges mert ebből a cloud környezetből csak az Anthropic proxyn keresztül
 * lehet kimenni, de az ingatlan.com blokkolja a cloud IP-ket.
 * Ez a híd láncolja a két proxyt.
 */
import http from 'http'
import net from 'net'
import { URL } from 'url'

export const BRIDGE_PORT = 9090
export const BRIDGE_HOST = '127.0.0.1'

const anthropicProxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY

/**
 * Nyit egy TCP socketet az Anthropic proxyn keresztül a célhoz
 */
function tunnelThroughAnthropicProxy(targetHost, targetPort) {
	return new Promise((resolve, reject) => {
		const ap = new URL(anthropicProxyUrl)

		const socket = net.connect({ host: ap.hostname, port: parseInt(ap.port) }, () => {
			const auth = Buffer.from(
				`${decodeURIComponent(ap.username)}:${decodeURIComponent(ap.password)}`
			).toString('base64')

			socket.write(
				`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
					`Host: ${targetHost}:${targetPort}\r\n` +
					`Proxy-Authorization: Basic ${auth}\r\n` +
					`\r\n`
			)
		})

		socket.once('data', (data) => {
			const response = data.toString()
			if (response.includes('200')) {
				resolve(socket)
			} else {
				socket.destroy()
				reject(new Error(`Anthropic proxy CONNECT failed: ${response.split('\r\n')[0]}`))
			}
		})

		socket.on('error', reject)
		setTimeout(() => reject(new Error('Anthropic proxy timeout')), 15000)
	})
}

/**
 * Proxy-lánc létrehozása: Anthropic proxy → user proxy → target
 */
async function chainedConnect(targetHost, targetPort, userProxyUrl) {
	const up = new URL(userProxyUrl)

	// 1. lépés: tunnel az Anthropic proxyn keresztül a user proxy-hoz
	const socket = await tunnelThroughAnthropicProxy(up.hostname, parseInt(up.port))

	// 2. lépés: CONNECT a user proxyn keresztül a célhoz
	return new Promise((resolve, reject) => {
		const userAuth = Buffer.from(
			`${decodeURIComponent(up.username)}:${decodeURIComponent(up.password)}`
		).toString('base64')

		socket.write(
			`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
				`Host: ${targetHost}:${targetPort}\r\n` +
				`Proxy-Authorization: Basic ${userAuth}\r\n` +
				`\r\n`
		)

		socket.once('data', (data) => {
			const response = data.toString()
			if (response.includes('200')) {
				resolve(socket)
			} else {
				socket.destroy()
				reject(new Error(`User proxy CONNECT failed: ${response.split('\r\n')[0]}`))
			}
		})

		socket.on('error', reject)
		setTimeout(() => reject(new Error('User proxy timeout')), 15000)
	})
}

/**
 * Helyi proxy szerver indítása
 */
export function startBridge(userProxyUrl) {
	const server = http.createServer()

	// HTTP CONNECT kezelése (HTTPS tunnelekhez)
	server.on('connect', async (req, clientSocket, head) => {
		const [host, port] = req.url.split(':')
		const targetPort = parseInt(port) || 443

		try {
			const remoteSocket = await chainedConnect(host, targetPort, userProxyUrl)

			clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

			if (head && head.length > 0) remoteSocket.write(head)

			remoteSocket.pipe(clientSocket)
			clientSocket.pipe(remoteSocket)

			remoteSocket.on('error', () => clientSocket.destroy())
			clientSocket.on('error', () => remoteSocket.destroy())
		} catch (err) {
			console.error(`[bridge] CONNECT ${req.url} failed: ${err.message}`)
			clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
			clientSocket.destroy()
		}
	})

	// HTTP (nem CONNECT) kezelése
	server.on('request', async (req, res) => {
		try {
			const targetUrl = new URL(req.url)
			const host = targetUrl.hostname
			const port = parseInt(targetUrl.port) || 80

			const socket = await tunnelThroughAnthropicProxy(host, port)

			// Továbbítjuk a kérést
			const requestLine = `${req.method} ${targetUrl.pathname}${targetUrl.search} HTTP/1.1\r\n`
			const headers = Object.entries(req.headers)
				.map(([k, v]) => `${k}: ${v}`)
				.join('\r\n')

			socket.write(`${requestLine}${headers}\r\n\r\n`)
			req.pipe(socket)
			socket.pipe(res)

			socket.on('error', () => res.destroy())
		} catch (err) {
			console.error(`[bridge] HTTP ${req.url} failed: ${err.message}`)
			res.writeHead(502)
			res.end()
		}
	})

	return new Promise((resolve, reject) => {
		server.listen(BRIDGE_PORT, BRIDGE_HOST, () => {
			console.log(`🌉 Proxy híd indul: localhost:${BRIDGE_PORT} → user proxy → ingatlan.com`)
			resolve(server)
		})
		server.on('error', reject)
	})
}
