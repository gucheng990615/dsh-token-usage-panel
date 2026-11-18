// dsh-token-usage-panel — browser half (v0.4).
//
// Token-first readout, no local money math:
//   • this session and every listed Session: token counts from the Host's own
//     `session/projections` reads (whole durable log, not the lagging push view)
//   • money: only what the official DeepSeek endpoint reports. The page asks the
//     same-origin route this plugin's host half registers
//     (`/plugins-api/token-usage/balance`), which calls
//     `https://api.deepseek.com/user/balance` with the machine's API key.
window.__ModuleLoader__.load({
	id: "dsh-token-usage-panel",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ReactDOM = require("react-dom");
		const h = React.createElement;

		/** Locale namespace owned by this plugin. */
		const NS = "token-usage";
		/** Slot id inside `conversation.session.header.actions`. */
		const SLOT_ID = "token-usage";
		/** Same-origin routes served by this plugin's host half. */
		const BALANCE_ROUTE = "/plugins-api/token-usage/balance";
		const KEYS_ROUTE = "/plugins-api/token-usage/keys";
		const KEY_ROUTE = "/plugins-api/token-usage/key";
		/** Re-read the balance at most this often. */
		const BALANCE_TTL_MS = 30000;
				/** Re-read cross-session usage at most this often. */
		const USAGE_TTL_MS = 20000;
		/** Re-read the API-key inventory at most this often. */
		const KEYS_CACHE_MS = 60000;
		/** Read at most this many sessions per aggregation pass. */
		const USAGE_SESSION_LIMIT = 40;

		//#region numbers
		/** Fallback projection reader for environments without the standard prop. */
		const INERT_PROJECTION = () => undefined;
		/** Fallback selector for environments without the standard prop. */
		const INERT_SELECT = () => false;

		/** Coerce a projection count to a non-negative finite number. */
		function asNumber(value) {
			return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
		}

		/** Coerce an optional count, keeping "absent" distinct from zero. */
		function optionalNumber(value) {
			return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
		}

		function trimZeros(text) {
			return text.indexOf(".") === -1 ? text : text.replace(/0+$/u, "").replace(/\.$/u, "");
		}

		/** Compact human reading: 916 / 12.4k / 3.28M / 1.2B. */
		function formatCompact(value) {
			const n = Math.round(asNumber(value));
			if (n < 1000) return String(n);
			if (n < 1000000) {
				const scaled = n / 1000;
				const digits = scaled < 10 ? 2 : scaled < 100 ? 1 : 0;
				return trimZeros(scaled.toFixed(digits)) + "k";
			}
			if (n < 1000000000) {
				const scaled = n / 1000000;
				return trimZeros(scaled.toFixed(scaled < 10 ? 2 : 1)) + "M";
			}
			const scaled = n / 1000000000;
			return trimZeros(scaled.toFixed(scaled < 10 ? 2 : 1)) + "B";
		}

		/** Exact reading with thousands separators. */
		function formatExact(value) {
			return String(Math.round(asNumber(value))).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
		}

		/**
		 * Readable token counts: 万/亿 for Chinese locales, k/M/B otherwise.
		 * Small values keep plain digit grouping.
		 * @param value - the count.
		 * @param locale - active UI locale id (`zh-CN`, `en`, …).
		 * @returns the display string.
		 */
		function formatCount(value, locale) {
			const n = Math.round(asNumber(value));
			const chinese = String(locale === undefined || locale === null ? "zh" : locale).toLowerCase().indexOf("zh") === 0;
			if (chinese) {
				if (n >= 100000000) return trimZeros((n / 100000000).toFixed(2)) + "亿";
				if (n >= 1000000) return String(Math.round(n / 10000)) + "万";
				if (n >= 10000) return trimZeros((n / 10000).toFixed(1)) + "万";
				return formatExact(n);
			}
			if (n >= 1000000000) return trimZeros((n / 1000000000).toFixed(2)) + "B";
			if (n >= 1000000) return trimZeros((n / 1000000).toFixed(2)) + "M";
			if (n >= 10000) return trimZeros((n / 1000).toFixed(1)) + "k";
			return formatExact(n);
		}

		/** Currency symbol for an ISO code the endpoint returned. */
		function currencySymbol(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		/** Render one amount string exactly as the endpoint sent it. */
		function formatAmount(amount, currency) {
			const text = typeof amount === "string" && amount.trim() !== "" ? amount.trim() : "0.00";
			return currencySymbol(currency) + text;
		}

		/** Render a numeric amount with a readable number of decimals. */
		function formatMoney(value, currency) {
			const n = Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : 0);
			const symbol = currencySymbol(currency);
			if (n === 0) return symbol + "0.00";
			if (n >= 100) return symbol + n.toFixed(1);
			if (n >= 1) return symbol + n.toFixed(2);
			return symbol + n.toFixed(3);
		}

		/** Whole-percent ratio, clamped, or undefined when the denominator is unusable. */
		function formatPercent(part, whole) {
			if (!(whole > 0)) return undefined;
			return Math.max(0, Math.min(100, Math.round((part / whole) * 100)));
		}

		/** Tokens per second over a span, or undefined. */
		function formatRate(tokens, ms) {
			if (!(ms > 0) || !(tokens > 0)) return undefined;
			const rate = tokens / (ms / 1000);
			return rate >= 10 ? String(Math.round(rate)) : rate.toFixed(1);
		}

		/** Wall time for durations in the millisecond range. */
		function formatDuration(ms) {
			const value = asNumber(ms);
			if (value < 1000) return Math.round(value) + "ms";
			const seconds = value / 1000;
			if (seconds < 60) return trimZeros(seconds.toFixed(1)) + "s";
			const minutes = Math.floor(seconds / 60);
			return minutes + "m " + Math.round(seconds - minutes * 60) + "s";
		}

		/** `HH:MM` clock reading for a timestamp. */
		function formatClock(at) {
			if (typeof at !== "number" || !Number.isFinite(at)) return undefined;
			const date = new Date(at);
			return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
		}
		//#endregion

		//#region folds
		/**
		 * Read a `tokenUsage` value into the figures the panel renders.
		 * @param usage - `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`.
		 * @returns the derived buckets, or undefined while the value is absent.
		 */
		function deriveUsage(usage) {
			if (usage === null || typeof usage !== "object") return undefined;
			const uncachedInput = asNumber(usage.uncachedInputTokens);
			const cacheRead = asNumber(usage.cacheReadTokens);
			const cacheWrite = asNumber(usage.cacheWriteTokens);
			const output = asNumber(usage.outputTokens);
			const billedInput = uncachedInput + cacheRead + cacheWrite;
			return {
				uncachedInput,
				cacheRead,
				cacheWrite,
				output,
				billedInput,
				total: billedInput + output,
				cacheHit: formatPercent(cacheRead, billedInput)
			};
		}

		/**
		 * Read the `contextPressure` wire view.
		 * @param pressure - `{ pressureTokens?, projectedTokens?, contextWindow? }`.
		 * @returns occupancy figures, or undefined while the key is absent.
		 */
		function deriveContext(pressure) {
			if (pressure === null || typeof pressure !== "object") return undefined;
			const last = optionalNumber(pressure.pressureTokens);
			const projected = optionalNumber(pressure.projectedTokens);
			const contextWindow = optionalNumber(pressure.contextWindow);
			const base = projected !== undefined ? projected : last;
			const occupancy = contextWindow !== undefined && base !== undefined ? formatPercent(base, contextWindow) : undefined;
			return {
				last,
				projected,
				contextWindow,
				base,
				occupancy,
				remaining: contextWindow !== undefined && base !== undefined ? Math.max(0, contextWindow - base) : undefined
			};
		}

		/**
		 * Read the `contextBreakdown` wire view (heuristic composition).
		 * @param breakdown - `{ systemTokens, toolsTokens, messageTokens }`.
		 * @returns composition figures, or undefined while the key is absent.
		 */
		function deriveBreakdown(breakdown) {
			if (breakdown === null || typeof breakdown !== "object") return undefined;
			const system = asNumber(breakdown.systemTokens);
			const tools = asNumber(breakdown.toolsTokens);
			const messages = asNumber(breakdown.messageTokens);
			if (system === 0 && tools === 0 && messages === 0) return undefined;
			return { system, tools, messages };
		}

		/**
		 * Read the `sessionStats` wire view.
		 * @param stats - whole-log counts and wall times.
		 * @returns speed figures, or undefined before the first settled step.
		 */
		function deriveSpeed(stats) {
			if (stats === null || typeof stats !== "object") return undefined;
			const turns = asNumber(stats.turns);
			const steps = asNumber(stats.steps);
			if (steps === 0) return undefined;
			return {
				turns,
				steps,
				rate: formatRate(asNumber(stats.decodeTokens), asNumber(stats.decodeMs)),
				ttft: asNumber(stats.ttftSteps) > 0 ? asNumber(stats.ttftMs) / asNumber(stats.ttftSteps) : undefined,
				llmMs: asNumber(stats.llmMs),
				toolMs: asNumber(stats.toolMs)
			};
		}

		/**
		 * Turn the key inventory into per-wallet balance rows.
		 * @param inventory - `createKeysStore` snapshot.
		 * @returns `[{ id, name, masked, models, providers, currency, total, granted, toppedUp, ok, isNew, source }]`.
		 */
		function deriveWallets(inventory) {
			if (inventory === undefined || inventory === null || !Array.isArray(inventory.keys)) return [];
			const wallets = [];
			for (const entry of inventory.keys) {
				const balance = entry.balance;
				if (balance === undefined || balance.ok !== true || !Number.isFinite(balance.total)) continue;
				const currency = typeof balance.currency === "string" && balance.currency !== "" ? balance.currency : "CNY";
				wallets.push({
					id: entry.name,
					name: entry.name,
					masked: entry.masked,
					models: Array.isArray(entry.models) ? entry.models : [],
					providers: Array.isArray(entry.providers) ? entry.providers : [],
					currency,
					total: balance.total,
					granted: Number.isFinite(balance.granted) ? balance.granted : undefined,
					toppedUp: Number.isFinite(balance.toppedUp) ? balance.toppedUp : undefined,
					ok: true,
					isNew: entry.isNew === true,
					source: typeof balance.source === "string" ? balance.source : undefined
				});
			}
			return wallets;
		}

		/**
		 * Pick the wallet that pays for the session's current model.
		 *
		 * Order: exact model id → provider/baseURL match → key-name family → the
		 * first wallet with a usable balance.
		 * @param wallets - `deriveWallets` output.
		 * @param selection - `modelSelection` projection (`{ next?, lastUsed? }`).
		 * @returns `{ wallet, reason }` or undefined.
		 */
		function walletForSelection(wallets, selection) {
			if (wallets.length === 0) return undefined;
			const target = selection === undefined || selection === null ? undefined : (selection.next ?? selection.lastUsed);
			const provider = (target === undefined || target === null ? "" : String(target.provider ?? "")).toLowerCase();
			const model = (target === undefined || target === null ? "" : String(target.model ?? "")).toLowerCase();
			if (model !== "") {
				for (const wallet of wallets) {
					if (wallet.models.some((id) => String(id).toLowerCase() === model)) return { wallet, reason: "model" };
				}
			}
			if (provider !== "") {
				for (const wallet of wallets) {
					const hit = wallet.providers.some((route) => {
						const id = String(route.provider ?? "").toLowerCase();
						const base = String(route.baseURL ?? "").toLowerCase();
						return (id !== "" && (id === provider || id.includes(provider) || provider.includes(id))) || (base !== "" && base.includes(provider));
					});
					if (hit) return { wallet, reason: "provider" };
				}
				const family = provider.includes("kimi") || provider.includes("moonshot")
					? ["kimi", "moonshot"]
					: provider.includes("deepseek") ? ["deepseek"] : [];
				for (const needle of family) {
					for (const wallet of wallets) {
						if (wallet.name.toLowerCase().includes(needle)) return { wallet, reason: "name" };
					}
				}
			}
			return { wallet: wallets[0], reason: "fallback" };
		}

		/**
		 * Sum the per-session usage rows into one bucket set.
		 * @param rows - `[{ id, usage }]`.
		 * @returns `{ sessions, included, usage }`.
		 */
		function sumUsageRows(rows) {
			const buckets = { uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
			let included = 0;
			for (const row of rows) {
				if (row.usage === undefined) continue;
				included++;
				buckets.uncachedInput += row.usage.uncachedInput;
				buckets.cacheRead += row.usage.cacheRead;
				buckets.cacheWrite += row.usage.cacheWrite;
				buckets.output += row.usage.output;
			}
			const billedInput = buckets.uncachedInput + buckets.cacheRead + buckets.cacheWrite;
			return {
				sessions: rows.length,
				included,
				usage: {
					...buckets,
					billedInput,
					total: billedInput + buckets.output,
					cacheHit: formatPercent(buckets.cacheRead, billedInput)
				}
			};
		}

		/** Occupancy severity used for the bar colour. */
		function occupancyLevel(percent) {
			if (percent === undefined) return undefined;
			if (percent >= 90) return "danger";
			if (percent >= 70) return "warn";
			return "normal";
		}

		/**
		 * Place the popover against the chip's rect and the current viewport.
		 *
		 * Width always leaves a gutter and never exceeds the viewport; the panel flips
		 * above the chip when the space below cannot hold a usable panel.
		 * @param rect - the chip's `getBoundingClientRect()`.
		 * @param viewport - `{ width, height }` of the window.
		 * @returns inline style with `top` or `bottom`, plus `left`, `width`, `maxHeight`.
		 */
		function computePanelPosition(rect, viewport, scale) {
			const viewportW = Math.max(200, viewport.width);
			const viewportH = Math.max(200, viewport.height);
			const factor = typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1;
			const preferred = Math.min(470, Math.round(430 * factor));
			const minWidth = Math.min(240, viewportW - 20);
			const width = Math.max(minWidth, Math.min(preferred, viewportW - 20));
			const left = Math.max(8, Math.min(rect.right - width, viewportW - width - 8));
			const below = viewportH - rect.bottom - 14;
			const above = rect.top - 14;
			const flip = below < 260 && above > below;
			const room = flip ? above : below;
			const maxHeight = Math.max(160, Math.min(room, 720));
			return flip
				? { bottom: Math.round(viewportH - rect.top + 8), left: Math.round(left), width, maxHeight }
				: { top: Math.round(rect.bottom + 8), left: Math.round(left), width, maxHeight };
		}

		/**
		 * Scale factor that lets the chip and the panel follow the window size.
		 * 1.0 up to 1440px wide, then a gentle +12% ceiling so a maximised window
		 * never dwarfs the surrounding UI.
		 * @param viewportWidth - window inner width in CSS pixels.
		 * @returns the factor, clamped to `[1, 1.12]`.
		 */
		function uiScale(viewportWidth) {
			const width = typeof viewportWidth === "number" && Number.isFinite(viewportWidth) ? viewportWidth : 1440;
			return Math.min(1.12, Math.max(1, width / 1440));
		}

		/** Track the window width so the chip and panel can rescale live. */
		function useViewportWidth() {
			const [width, setWidth] = React.useState(() => (typeof window === "undefined" ? 1440 : window.innerWidth));
			React.useEffect(() => {
				if (typeof window === "undefined") return undefined;
				let frame = null;
				const onResize = () => {
					if (frame !== null) return;
					frame = typeof requestAnimationFrame === "function"
						? requestAnimationFrame(() => {
							frame = null;
							setWidth(window.innerWidth);
						})
						: null;
					if (frame === null) setWidth(window.innerWidth);
				};
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
					if (frame !== null && typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
				};
			}, []);
			return width;
		}
		//#endregion

		//#region stores
		/** localStorage key holding the accent colour the panel paints with. */
		const ACCENT_KEY = "dsh-token-usage-panel/accent";
		/** localStorage key holding the two opacity values. */
		const OPACITY_KEY = "dsh-token-usage-panel/opacity";
		/** Offered swatches; the picker still accepts any colour. */
		const ACCENT_PRESETS = ["#4d6bfe", "#00a86b", "#f59e0b", "#ef4444", "#8b5cf6", "#0ea5e9"];

		/** Accept only `#rgb` / `#rrggbb` so a stray value cannot break the styles. */
		function normalizeAccent(value) {
			return typeof value === "string" && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu.test(value.trim()) ? value.trim() : undefined;
		}

		/** Inline style carrying the accent variable into one subtree. */
		function accentStyle(accent) {
			return accent === undefined ? undefined : { "--dsh-tup-accent": accent };
		}

		/**
		 * Opacity store: separate alpha for the chip (悬浮窗) and the popover,
		 * persisted per browser. 1 = fully opaque.
		 * @returns `{ getSnapshot, subscribe, set, reset, dispose }`.
		 */
		function createOpacityStore() {
			const clamp = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0.2, value)) : fallback);
			const read = () => {
				try {
					const parsed = JSON.parse(window.localStorage.getItem(OPACITY_KEY) ?? "{}");
					return { panel: clamp(parsed.panel, 1) };
				} catch (error) {
					return { panel: 1 };
				}
			};
			let snapshot = read();
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const write = (next) => {
				try {
					window.localStorage.setItem(OPACITY_KEY, JSON.stringify(next));
				} catch (error) {
					// Storage unavailable: the values still apply for this page.
				}
				publish(next);
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (value) => {
					write({ panel: clamp(value, 1) });
				},
				reset: () => write({ panel: 1 }),
				dispose: () => {
					listeners.clear();
				}
			};
		}

		/** Inline style carrying both opacity variables into one subtree. */
		function opacityStyle(opacity) {
			const chip = opacity === undefined || opacity === null || typeof opacity.chip !== "number" ? 1 : opacity.chip;
			const panel = opacity === undefined || opacity === null || typeof opacity.panel !== "number" ? 1 : opacity.panel;
			return { "--dsh-tup-panel-alpha": String(panel) };
		}

		/**
		 * Accent-colour store: the colour this plugin paints with, persisted per browser.
		 * @returns `{ getSnapshot, subscribe, set, reset, dispose }`.
		 */
		function createAccentStore() {
			let initial;
			try {
				initial = normalizeAccent(window.localStorage.getItem(ACCENT_KEY) ?? "");
			} catch (error) {
				initial = undefined;
			}
			let snapshot = { accent: initial };
			const listeners = new Set();
			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};
			const write = (accent) => {
				try {
					if (accent === undefined) window.localStorage.removeItem(ACCENT_KEY);
					else window.localStorage.setItem(ACCENT_KEY, accent);
				} catch (error) {
					// Storage unavailable: the colour still applies for this page.
				}
				publish({ accent });
			};
			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				set: (value) => {
					write(normalizeAccent(value));
				},
				reset: () => write(undefined),
				dispose: () => {
					listeners.clear();
				}
			};
		}

		/**
		 * API-key inventory store: every credential reference the Host found, the
		 * provider routes and models that consume it, its balance, and whether it
		 * appeared after the previous scan.
		 * @returns `{ getSnapshot, subscribe, refresh, ensureFresh, dispose }`.
		 */
		function createKeysStore() {
			let snapshot = { status: "idle", keys: [], scannedAt: undefined, refreshing: false };
			const listeners = new Set();
			let inflight = null;
			let fetchedAt = 0;

			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};

			const read = async (force) => {
				try {
					const response = await fetch(KEYS_ROUTE + (force === true ? "?refresh=1" : ""), { method: "GET", headers: { accept: "application/json" } });
					const contentType = response.headers.get("content-type") ?? "";
					if (!contentType.includes("application/json")) {
						publish({ status: "failed", keys: [], error: "http " + response.status + " — keys route not registered", refreshing: false });
						return;
					}
					const payload = await response.json();
					if (payload === null || typeof payload !== "object" || payload.ok !== true) {
						publish({ status: "failed", keys: [], error: payload !== null && typeof payload === "object" && typeof payload.error === "string" ? payload.error : "unexpected response", refreshing: false });
						return;
					}
					fetchedAt = Date.now();
					publish({
						status: "ready",
						keys: Array.isArray(payload.keys) ? payload.keys : [],
						scannedAt: typeof payload.scannedAt === "number" ? payload.scannedAt : fetchedAt,
						credentials: typeof payload.credentials === "string" ? payload.credentials : undefined,
						refreshing: false
					});
				} catch (error) {
					publish({ status: "failed", keys: [], error: error instanceof Error ? error.message : String(error), refreshing: false });
				}
			};

			const refresh = () => {
				if (inflight !== null) return inflight;
				publish({ ...snapshot, status: snapshot.status === "ready" ? "ready" : "loading", refreshing: true });
				inflight = read(true).finally(() => {
					inflight = null;
				});
				return inflight;
			};

			const ensureFresh = () => {
				if (snapshot.status === "ready" && Date.now() - fetchedAt < KEYS_CACHE_MS) return undefined;
				if (inflight !== null) return inflight;
				publish({ ...snapshot, status: snapshot.status === "ready" ? "ready" : "loading", refreshing: true });
				inflight = read(false).finally(() => {
					inflight = null;
				});
				return inflight;
			};

			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				refresh,
				ensureFresh,
				dispose: () => {
					listeners.clear();
				}
			};
		}

		/**
		 * Cross-session usage store: one Host-side projection read per listed
		 * Session, kept in a page-lifetime cache.
		 * @param ctx - client root context.
		 * @returns `{ getSnapshot, subscribe, refresh, ensureFresh, dispose }`.
		 */		function createUsageStore(ctx) {
			let snapshot = { status: "idle", rows: [], totals: undefined, at: undefined, refreshing: false };
			const listeners = new Set();
			let inflight = null;
			let fetchedAt = 0;

			const publish = (next) => {
				snapshot = next;
				for (const listener of listeners) listener();
			};

			const safe = (read) => {
				try {
					return read();
				} catch (error) {
					return undefined;
				}
			};

			const sessionApi = () => {
				const routes = [safe(() => ctx.get("remote.session")), safe(() => ctx.get("remote")?.session)];
				for (const candidate of routes) {
					if (candidate !== undefined && candidate !== null && typeof candidate.projections === "function") return candidate;
				}
				return undefined;
			};

			const listedSessions = () => {
				const service = safe(() => ctx.get("sessions")) ?? safe(() => ctx.sessions);
				const list = safe(() => service?.list?.getSnapshot?.());
				const ids = list !== undefined && Array.isArray(list.ids) ? list.ids : [];
				return ids.map((id) => ({
					id,
					title: list.byId !== undefined && list.byId !== null && list.byId[id] !== undefined && typeof list.byId[id].title === "string" ? list.byId[id].title : undefined
				}));
			};

			const read = async () => {
				const api = sessionApi();
				if (api === undefined) {
					publish({ ...snapshot, status: "unavailable", refreshing: false });
					return;
				}
				const listed = listedSessions();
				const rows = [];
				for (const entry of listed.slice(0, USAGE_SESSION_LIMIT)) {
					try {
						const result = await api.projections({ sessionId: entry.id });
						if (result === undefined || result === null || result.ok !== true) continue;
						const value = result.value;
						if (value === undefined || value === null) continue;
						const values = value.values === undefined || value.values === null ? {} : value.values;
						const usage = deriveUsage(values.tokenUsage);
						if (usage === undefined) continue;
						rows.push({ id: entry.id, title: entry.title, usage });
					} catch (error) {
						// A session that refuses its projection read simply does not count.
					}
				}
				fetchedAt = Date.now();
				publish({
					status: "ready",
					rows,
					totals: sumUsageRows(rows),
					listed: listed.length,
					at: fetchedAt,
					refreshing: false
				});
			};

			const refresh = () => {
				if (inflight !== null) return inflight;
				publish({ ...snapshot, status: snapshot.status === "ready" ? "ready" : "loading", refreshing: true });
				inflight = read().finally(() => {
					inflight = null;
				});
				return inflight;
			};

			const ensureFresh = () => {
				if (snapshot.status === "ready" && Date.now() - fetchedAt < USAGE_TTL_MS) return undefined;
				if (inflight !== null) return inflight;
				return refresh();
			};

			return {
				getSnapshot: () => snapshot,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				refresh,
				ensureFresh,
				dispose: () => {
					listeners.clear();
				}
			};
		}
		//#endregion

		//#region dictionaries
		/** Simplified Chinese dictionary: the key-set source of truth. */
		const zh = {
			"pill.title": "Token 用量与账户余额 · 点击查看明细",
			"pill.aria": "全部会话 {all} tokens，本会话 {session} tokens，余额 {balance}",
			"pill.all": "全",
			"pill.session": "本",
			
			"pill.tokens": "{tokens} tok",
			"pill.balance": "余 {amount}",
			"pill.balanceUnknown": "余 —",
			"panel.title": "Token 用量与余额",
			"hero.balance": "可用余额",
			"hero.tokens": "全部 {all} · 本会话 {session}",
			"hero.sessions": "{count} 个会话",
			"section.all": "全部会话",
			"section.usage": "本会话用量",
			"section.context": "本会话上下文",
			"section.composition": "构成（估算）",
			"section.speed": "速度",
			"section.balance": "官方钱包（API Key）",
			"section.keys": "API Key 清单",
			"theme.label": "颜色",
			"theme.custom": "自定义颜色",
			"theme.reset": "默认",
			"theme.opacity": "面板透明度",
			"theme.panel": "面板",
			"row.sessions": "会话数",
			"row.allTokens": "合计 tokens",
			"row.uncachedInput": "输入（未缓存）",
			"row.cacheRead": "缓存读取（命中）",
			"row.cacheWrite": "缓存写入",
			"row.output": "输出",
			"row.total": "合计",
			"row.cacheHit": "缓存命中率",
			"row.used": "已用",
			"row.remainingTokens": "剩余",
			"row.lastPrompt": "上次请求提示",
			"row.projected": "下次请求预估",
			"row.contextWindow": "上下文窗口",
			"row.model": "当前模型",
			"row.system": "系统提示",
			"row.tools": "工具声明",
			"row.messages": "消息",
			"row.turns": "轮次 / 步数",
			"row.rate": "生成速度",
			"row.ttft": "首字延迟",
			"row.llmTime": "模型用时",
			"row.toolTime": "工具用时",
			"row.available": "可用",
			
			"row.keyCount": "Key 数量",
			"row.noModels": "(未映射模型)",
			"row.source": "数据源",
			"key.new": "新",
			"key.current": "当前",
			"row.granted": "赠金",
			"row.toppedUp": "充值",
			
			"row.updated": "更新于",
			"balance.loading": "查询中…",
			"balance.failed": "查询失败：{error}",
			"balance.unavailable": "宿主路由未就绪（重启一次应用）",
			"balance.noKey": "未配置 DeepSeek API Key",
			"balance.noKeyHint": "填一个 API Key 就能显示官方余额（只保存在本机 $DSH_HOME/.dsh-token-usage-panel.json）",
			"balance.keyPlaceholder": "sk-...",
			"balance.save": "保存并查询",
			"balance.notAvailable": "账户余额不可用",
			"usage.loading": "统计中…",
			"usage.unavailable": "会话统计不可用",
			"action.refresh": "刷新",
			"action.copy": "复制",
			"action.copied": "已复制",
			"empty": "还没有用量数据。",
			"foot.note": "token 来自宿主投影；余额来自 api.deepseek.com/user/balance"
		};
		/** English dictionary, key-identical to the Chinese source of truth. */
		const en = {
			"pill.title": "Token usage and account balance · click for details",
			"pill.aria": "All sessions {all} tokens, this session {session} tokens, balance {balance}",
			"pill.all": "All",
			"pill.session": "This",
			
			"pill.tokens": "{tokens} tok",
			"pill.balance": "{amount} left",
			"pill.balanceUnknown": "— left",
			"panel.title": "Token usage and balance",
			
			"hero.balance": "Available",
			"hero.tokens": "all {all} · this {session}",
			"hero.sessions": "{count} sessions",
			"section.all": "All sessions",
			"section.usage": "This session",
			"section.context": "Context (this session)",
			"section.composition": "Composition (heuristic)",
			"section.speed": "Speed",
			"section.balance": "Official wallet (API key)",
			"section.keys": "API keys",
			"theme.label": "Color",
			"theme.custom": "Custom color",
			"theme.reset": "Default",
			"theme.opacity": "Panel opacity",
			"theme.panel": "Panel",
			"row.sessions": "Sessions",
			"row.allTokens": "Total tokens",
			"row.uncachedInput": "Input (uncached)",
			"row.cacheRead": "Cache read (hit)",
			"row.cacheWrite": "Cache write",
			"row.output": "Output",
			"row.total": "Total",
			"row.cacheHit": "Cache hit rate",
			"row.used": "Used",
			"row.remainingTokens": "Remaining",
			"row.lastPrompt": "Last request prompt",
			"row.projected": "Next request estimate",
			"row.contextWindow": "Context window",
			"row.model": "Current model",
			"row.system": "System prompt",
			"row.tools": "Tool schemas",
			"row.messages": "Messages",
			"row.turns": "Turns / steps",
			"row.rate": "Decode speed",
			"row.ttft": "Time to first token",
			"row.llmTime": "Model time",
			"row.toolTime": "Tool time",
			"row.available": "Available",
			
			"row.keyCount": "Keys",
			"row.noModels": "(no mapped models)",
			"row.source": "Source",
			"key.new": "NEW",
			"key.current": "current",
			"row.granted": "Granted",
			"row.toppedUp": "Topped up",
			
			"row.updated": "Updated",
			"balance.loading": "Querying…",
			"balance.failed": "Query failed: {error}",
			"balance.unavailable": "Host route not ready (restart the app once)",
			"balance.noKey": "No DeepSeek API key configured",
			"balance.noKeyHint": "Paste an API key to read the official balance (kept on this machine only, in $DSH_HOME/.dsh-token-usage-panel.json)",
			"balance.keyPlaceholder": "sk-...",
			"balance.save": "Save and query",
			"balance.notAvailable": "Account balance unavailable",
			"usage.loading": "Counting…",
			"usage.unavailable": "Session totals unavailable",
			"action.refresh": "Refresh",
			"action.copy": "Copy",
			"action.copied": "Copied",
			"empty": "No usage recorded yet.",
			"foot.note": "tokens from Host projections; balance from api.deepseek.com/user/balance"
		};
		//#endregion

		//#region styles
		const STYLE_ID = "dsh-token-usage-panel/panel.css";
		const CSS = [
			".dsh-tup-anchor{position:relative;display:inline-flex;align-items:center;min-width:0}",
			".dsh-tup-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:9px;height:calc(38px * var(--dsh-tup-scale,1));padding:0 calc(12px * var(--dsh-tup-scale,1));border-radius:10px;border:1px solid color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 26%,transparent);background-image:linear-gradient(135deg,color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 16%,transparent),color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 5%,transparent));color:var(--dsw-alias-label-primary);cursor:pointer;font-family:var(--dsw-font-family);transition:transform .15s ease,border-color .15s ease,background .15s ease,box-shadow .15s ease}",
			".dsh-tup-trigger:hover,.dsh-tup-trigger:focus-visible{transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 48%,transparent);box-shadow:0 3px 12px color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 20%,transparent);outline:0}",
			".dsh-tup-trigger[data-open=\"true\"]{border-color:color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 60%,transparent);background:linear-gradient(135deg,color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 24%,transparent),color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 10%,transparent))}",
			".dsh-tup-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--dsh-tup-accent,var(--dsw-alias-brand-primary));box-shadow:0 0 0 3px color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 20%,transparent)}",
			".dsh-tup-dot[data-live=\"true\"]{animation:dsh-tup-pulse 1.4s ease-in-out infinite}",
			"@keyframes dsh-tup-pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.45}}",
			".dsh-tup-tokensMain{font-family:var(--dsw-font-mono);font-size:calc(17px * var(--dsh-tup-scale,1));line-height:calc(21px * var(--dsh-tup-scale,1));font-weight:600;letter-spacing:-.02em}",
			".dsh-tup-tag{color:var(--dsw-alias-label-quaternary);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(16px * var(--dsh-tup-scale,1))}",
			".dsh-tup-hit{flex:none;margin-right:4px;padding:1px 7px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 16%,transparent);color:var(--dsw-alias-state-success-primary);font-family:var(--dsw-font-mono);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(16px * var(--dsh-tup-scale,1))}",
			".dsh-tup-current{flex:none;margin-right:4px;padding:1px 6px;border-radius:999px;background:color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 18%,transparent);color:var(--dsh-tup-accent,var(--dsw-alias-brand-primary));font-family:var(--dsw-font-mono);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(16px * var(--dsh-tup-scale,1))}",
			".dsh-tup-sub{color:var(--dsw-alias-label-tertiary);font-family:var(--dsw-font-mono);font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(18px * var(--dsh-tup-scale,1));white-space:nowrap}",
			".dsh-tup-panel{box-sizing:border-box;z-index:1000;display:flex;flex-direction:column;gap:calc(11px * var(--dsh-tup-scale,1));padding:calc(16px * var(--dsh-tup-scale,1)) calc(18px * var(--dsh-tup-scale,1)) calc(14px * var(--dsh-tup-scale,1));border:.5px solid color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 22%,var(--dsw-alias-border-l1));border-radius:14px;background-color:var(--dsw-specific-menu);background-color:rgb(from var(--dsw-specific-menu) r g b / var(--dsh-tup-panel-alpha,1));box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-primary);overflow:auto;overscroll-behavior:contain;position:fixed}",
			".dsh-tup-hero{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}",
			".dsh-tup-heroMain{display:flex;flex-direction:column;gap:1px;min-width:0}",
			".dsh-tup-heroLabel{color:var(--dsw-alias-label-tertiary);font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(18px * var(--dsh-tup-scale,1));letter-spacing:.02em}",
			".dsh-tup-heroValue{font-family:var(--dsw-font-mono);font-size:calc(30px * var(--dsh-tup-scale,1));line-height:calc(36px * var(--dsh-tup-scale,1));font-weight:600;letter-spacing:-.02em}",
			".dsh-tup-heroValue[data-balance=\"true\"]{font-size:calc(40px * var(--dsh-tup-scale,1));line-height:calc(46px * var(--dsh-tup-scale,1));font-weight:700;letter-spacing:-.03em;color:var(--dsh-tup-accent,var(--dsw-alias-brand-primary))}",
			".dsh-tup-heroSide{display:flex;flex-direction:column;align-items:flex-end;gap:2px;min-width:0;text-align:right;padding-top:2px}",
			".dsh-tup-heroBalance{font-family:var(--dsw-font-mono);font-size:calc(19px * var(--dsh-tup-scale,1));line-height:calc(24px * var(--dsh-tup-scale,1));font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dsh-tup-heroNote{color:var(--dsw-alias-label-tertiary);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(17px * var(--dsh-tup-scale,1))}",
			".dsh-tup-barWrap{display:flex;flex-direction:column;gap:3px}",
			".dsh-tup-bar{position:relative;height:8px;border-radius:4px;background:var(--dsw-alias-fill-l2);overflow:hidden}",
			".dsh-tup-barFill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)),color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 55%,transparent));transition:width .2s ease}",
			".dsh-tup-barFill[data-level=\"warn\"]{background:linear-gradient(90deg,var(--dsw-alias-state-warn-primary),color-mix(in srgb,var(--dsw-alias-state-warn-primary) 55%,transparent))}",
			".dsh-tup-barFill[data-level=\"danger\"]{background:linear-gradient(90deg,var(--dsw-alias-state-error-primary),color-mix(in srgb,var(--dsw-alias-state-error-primary) 55%,transparent))}",
			".dsh-tup-barLabels{display:flex;align-items:baseline;justify-content:space-between;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(17px * var(--dsh-tup-scale,1))}",
			".dsh-tup-section{display:flex;flex-direction:column;gap:2px}",
			".dsh-tup-sectionTitle{color:var(--dsw-alias-label-tertiary);margin-top:2px;font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(18px * var(--dsh-tup-scale,1));letter-spacing:.02em}",
			".dsh-tup-row{display:flex;align-items:baseline;justify-content:space-between;gap:10px;font-size:calc(14px * var(--dsh-tup-scale,1));line-height:calc(22px * var(--dsh-tup-scale,1))}",
			".dsh-tup-label{color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
			".dsh-tup-right{display:inline-flex;align-items:baseline;gap:8px;min-width:0}",
			".dsh-tup-tokens{font-family:var(--dsw-font-mono);font-size:calc(13px * var(--dsh-tup-scale,1));color:var(--dsw-alias-label-quaternary);font-variant-numeric:tabular-nums}",
			".dsh-tup-num{font-family:var(--dsw-font-mono);font-size:calc(13px * var(--dsh-tup-scale,1));color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}",
			".dsh-tup-num[data-strong=\"true\"]{font-size:calc(15px * var(--dsh-tup-scale,1));font-weight:600}",
			".dsh-tup-rule{height:1px;background:var(--dsw-alias-border-l1);margin:1px 0}",
			".dsh-tup-foot{color:var(--dsw-alias-label-tertiary);font-size:calc(12px * var(--dsh-tup-scale,1));line-height:calc(18px * var(--dsh-tup-scale,1))}",
			".dsh-tup-actions{display:flex;flex-direction:row;flex-wrap:nowrap;align-items:center;justify-content:flex-end;gap:8px;align-self:flex-end;white-space:nowrap}",
			".dsh-tup-button{border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:3px 12px;font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(20px * var(--dsh-tup-scale,1));white-space:nowrap;flex:none}",
			".dsh-tup-button:hover,.dsh-tup-button:focus-visible{background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);outline:0}",
			".dsh-tup-input{box-sizing:border-box;flex:1;min-width:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono);font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(20px * var(--dsh-tup-scale,1));padding:3px 8px;outline:0}",
			".dsh-tup-input:focus{border-color:color-mix(in srgb,var(--dsh-tup-accent,var(--dsw-alias-brand-primary)) 55%,transparent)}",
			".dsh-tup-keyForm{display:flex;align-items:center;gap:6px}",
			".dsh-tup-accent{display:flex;align-items:center;gap:7px;flex-wrap:wrap}",
			".dsh-tup-alpha{display:inline-flex;align-items:center;gap:5px}",
			".dsh-tup-alphaLabel{color:var(--dsw-alias-label-tertiary);font-size:calc(12px * var(--dsh-tup-scale,1))}",
			".dsh-tup-alphaValue{width:34px;text-align:right;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono);font-size:calc(12px * var(--dsh-tup-scale,1))}",
			".dsh-tup-range{width:calc(76px * var(--dsh-tup-scale,1));accent-color:var(--dsh-tup-accent,var(--dsw-alias-brand-primary));cursor:pointer}",
			".dsh-tup-swatch{box-sizing:border-box;width:calc(18px * var(--dsh-tup-scale,1));height:calc(18px * var(--dsh-tup-scale,1));padding:0;border-radius:50%;border:1.5px solid transparent;cursor:pointer;outline:0;transition:transform .12s ease}",
			".dsh-tup-swatch[data-active=\"true\"]{border-color:var(--dsw-alias-label-primary);box-shadow:0 0 0 2px var(--dsh-tup-accent,var(--dsw-alias-brand-primary))}",
			".dsh-tup-swatch:hover{transform:scale(1.12)}",
			".dsh-tup-color{box-sizing:border-box;width:24px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;cursor:pointer}",
			"@media (max-width: 820px){.dsh-tup-trigger{height:32px;padding:0 9px;gap:7px}.dsh-tup-tokensMain{font-size:calc(15px * var(--dsh-tup-scale,1));line-height:calc(19px * var(--dsh-tup-scale,1))}.dsh-tup-sub{font-size:calc(11px * var(--dsh-tup-scale,1));line-height:calc(15px * var(--dsh-tup-scale,1))}.dsh-tup-tag{font-size:calc(10px * var(--dsh-tup-scale,1));line-height:calc(13px * var(--dsh-tup-scale,1))}}",
			"@media (max-width: 640px){.dsh-tup-trigger{gap:6px}.dsh-tup-trigger [data-role=\"tokens\"]{display:none}.dsh-tup-trigger [data-role=\"wallet\"]{display:none}}",
			"@media (max-width: 520px){.dsh-tup-heroValue[data-balance=\"true\"]{font-size:calc(30px * var(--dsh-tup-scale,1));line-height:calc(36px * var(--dsh-tup-scale,1))}.dsh-tup-heroBalance{font-size:calc(16px * var(--dsh-tup-scale,1));line-height:calc(21px * var(--dsh-tup-scale,1))}.dsh-tup-row{font-size:calc(13px * var(--dsh-tup-scale,1));line-height:calc(20px * var(--dsh-tup-scale,1))}.dsh-tup-num,.dsh-tup-tokens{font-size:calc(12px * var(--dsh-tup-scale,1))}.dsh-tup-num[data-strong=\"true\"]{font-size:calc(14px * var(--dsh-tup-scale,1))}.dsh-tup-panel{gap:calc(8px * var(--dsh-tup-scale,1));padding:calc(12px * var(--dsh-tup-scale,1)) calc(13px * var(--dsh-tup-scale,1)) calc(10px * var(--dsh-tup-scale,1))}.dsh-tup-sectionTitle,.dsh-tup-heroLabel,.dsh-tup-heroNote{font-size:calc(12px * var(--dsh-tup-scale,1))}.dsh-tup-swatch{width:16px;height:16px}}",
			"@media (max-height: 620px){.dsh-tup-panel{gap:calc(7px * var(--dsh-tup-scale,1));padding:calc(12px * var(--dsh-tup-scale,1)) calc(14px * var(--dsh-tup-scale,1)) calc(10px * var(--dsh-tup-scale,1))}.dsh-tup-heroValue[data-balance=\"true\"]{font-size:calc(32px * var(--dsh-tup-scale,1));line-height:calc(38px * var(--dsh-tup-scale,1))}.dsh-tup-row{line-height:calc(19px * var(--dsh-tup-scale,1))}}",
			".dsh-tup-empty{color:var(--dsw-alias-label-tertiary);font-size:calc(14px * var(--dsh-tup-scale,1));line-height:calc(20px * var(--dsh-tup-scale,1))}"
		].join("");

		/** Inject this plugin's stylesheet once; the module system reclaims it on teardown. */
		function injectStyle() {
			if (typeof document === "undefined") return;
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-usage-panel";
			tag.dataset.pluginCss = STYLE_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region components
		/** One label/value line. */
		function StatRow(props) {
			return h("div", { className: "dsh-tup-row" },
				h("span", { className: "dsh-tup-label", title: props.label }, props.label),
				h("span", { className: "dsh-tup-right" },
					props.tokens === undefined ? null : h("span", { className: "dsh-tup-tokens" }, props.tokens),
					h("span", {
						className: "dsh-tup-num",
						"data-strong": props.strong === true ? "true" : undefined
					}, props.value)));
		}

		/** One titled group of rows. */
		function Section(props) {
			return h("div", { className: "dsh-tup-section" },
				h("div", { className: "dsh-tup-sectionTitle" }, props.title),
				props.children);
		}

		/** Text form of the panel, for the clipboard. */
		function buildSummary(input) {
			const t = input.t;
			const count = (value) => formatCount(value, input.locale);
			const lines = [t("panel.title")];
			const wallet = input.wallet;
			if (wallet !== undefined) {
				const currency = wallet.currency === undefined ? "CNY" : wallet.currency;
				lines.push(wallet.name + " · " + t("row.available") + ": " + formatMoney(wallet.total, currency));
			}
			if (input.totals !== undefined) {
				lines.push(t("row.allTokens") + ": " + count(input.totals.usage.total) + " / " + t("hero.sessions", { count: input.totals.included }));
			}
			if (input.usage !== undefined) {
				lines.push(t("section.usage") + ": " + count(input.usage.total) + " tokens (" + t("row.cacheHit") + " " + (input.usage.cacheHit === undefined ? "—" : input.usage.cacheHit + "%") + ")");
			}
			return lines.join("\n");
		}

		/**
		 * The detail panel body.
		 *
		 * Props: `t`, `usage`, `context`, `breakdown`, `speed`, `balance`, `totals`,
		 * `sessions`, `model`, `onRefresh`, `onSaveKey`.
		 */
		function UsagePanel(props) {
			const t = props.t;
			const locale = typeof props.getLocale === "function" ? props.getLocale() : "zh";
			const count = (value) => formatCount(value, locale);
			const usage = props.usage;
			const context = props.context;
			const breakdown = props.breakdown;
			const speed = props.speed;
			const wallet = props.wallet;
			const wallets = Array.isArray(props.wallets) ? props.wallets : [];
			const totals = props.totals;
			const sessions = props.sessions;
			const [copied, setCopied] = React.useState(false);

			React.useEffect(() => {
				if (!copied) return undefined;
				const timer = setTimeout(() => setCopied(false), 1600);
				return () => clearTimeout(timer);
			}, [copied]);

			const copy = () => {
				const text = buildSummary({ t, totals, usage, wallet, locale });
				const done = () => setCopied(true);
				const fallback = () => {
					try {
						const area = document.createElement("textarea");
						area.value = text;
						area.style.position = "fixed";
						area.style.left = "-1000px";
						area.style.top = "0";
						document.body.appendChild(area);
						area.select();
						document.execCommand("copy");
						document.body.removeChild(area);
						done();
					} catch (error) {
						// Clipboard unavailable: leave the panel unchanged.
					}
				};
				try {
					if (typeof navigator !== "undefined" && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === "function") {
						navigator.clipboard.writeText(text).then(done, fallback);
						return;
					}
				} catch (error) {
					// Fall through to the textarea path.
				}
				fallback();
			};

			const walletReady = wallet !== undefined;
			const currency = wallet === undefined ? "CNY" : wallet.currency;
			const balanceText = walletReady ? formatMoney(wallet.total, currency) : t("balance.notAvailable");
			const walletName = walletReady ? wallet.name : t("usage.loading");

			// Parts of the active wallet, kept on one compact line under the hero.
			const walletParts = [];
			if (walletReady) {
				if (Number.isFinite(wallet.toppedUp)) walletParts.push(t("row.toppedUp") + " " + formatMoney(wallet.toppedUp, currency));
				if (Number.isFinite(wallet.granted) && wallet.granted > 0) walletParts.push(t("row.granted") + " " + formatMoney(wallet.granted, currency));
				if (typeof wallet.source === "string" && wallet.source !== "") walletParts.push(wallet.source);
			}

			const opacityPanel = props.opacity === undefined || props.opacity === null || typeof props.opacity.panel !== "number" ? 1 : props.opacity.panel;
			const hiddenOpacity = opacityPanel === 1;

			const children = [];
			// Balance first: the number people open this panel for.
			children.push(h("div", { className: "dsh-tup-hero", key: "hero" },
				h("div", { className: "dsh-tup-heroMain" },
					h("span", { className: "dsh-tup-heroLabel" }, t("hero.balance")),
					h("span", { className: "dsh-tup-heroValue", "data-balance": "true" }, balanceText),
					h("span", { className: "dsh-tup-heroNote" }, walletName)),
				h("div", { className: "dsh-tup-heroSide" },
					h("span", { className: "dsh-tup-heroNote" }, t("hero.tokens", {
						all: totals === undefined ? t("usage.loading") : count(totals.usage.total),
						session: usage === undefined ? "—" : count(usage.total)
					})))));

			if (walletParts.length > 0) {
				children.push(h("div", { className: "dsh-tup-heroNote", key: "walletParts" }, walletParts.join(" · ")));
			}

			const occupancy = context === undefined ? undefined : context.occupancy;
			if (occupancy !== undefined) {
				children.push(h("div", { className: "dsh-tup-barWrap", key: "bar" },
					h("div", { className: "dsh-tup-bar" },
						h("div", { className: "dsh-tup-barFill", "data-level": occupancyLevel(occupancy), style: { width: occupancy + "%" } })),
					h("div", { className: "dsh-tup-barLabels" },
						h("span", null, t("row.used") + " " + count(context.base) + " / " + count(context.contextWindow) + " · " + occupancy + "%"),
						h("span", null, t("row.remainingTokens") + " " + count(context.remaining)))));
			}

			// ---- all sessions ----
			if (totals !== undefined) {
				const rows = [
					h(StatRow, { key: "sessions", label: t("row.sessions"), value: String(totals.included) + " / " + String(totals.sessions) }),
					h(StatRow, { key: "total", label: t("row.allTokens"), value: count(totals.usage.total), strong: true }),
					h(StatRow, { key: "input", label: t("row.uncachedInput"), value: count(totals.usage.uncachedInput) }),
					h(StatRow, { key: "read", label: t("row.cacheRead"), value: count(totals.usage.cacheRead) }),
					h(StatRow, { key: "out", label: t("row.output"), value: count(totals.usage.output) }),
					h(StatRow, { key: "hit", label: t("row.cacheHit"), value: totals.usage.cacheHit === undefined ? "—" : totals.usage.cacheHit + "%" })
				];
				if (sessions !== undefined && sessions.length > 0) {
					const top = sessions.slice().sort((a, b) => b.usage.total - a.usage.total).slice(0, 4);
					for (const row of top) {
						rows.push(h(StatRow, {
							key: "s" + row.id,
							label: row.title === undefined || row.title === "" ? row.id.slice(-6) : row.title,
							value: count(row.usage.total)
						}));
					}
				}
				children.push(h(Section, { key: "all", title: t("section.all") }, rows));
			}

			// ---- this session ----
			if (usage !== undefined) {
				children.push(h(Section, { key: "usage", title: t("section.usage") },
					h(StatRow, { label: t("row.uncachedInput"), value: count(usage.uncachedInput) }),
					h(StatRow, { label: t("row.cacheRead"), value: count(usage.cacheRead) }),
					usage.cacheWrite > 0 ? h(StatRow, { label: t("row.cacheWrite"), value: count(usage.cacheWrite) }) : null,
					h(StatRow, { label: t("row.output"), value: count(usage.output) }),
					h(StatRow, { label: t("row.total"), value: count(usage.total), strong: true }),
					usage.cacheHit === undefined ? null : h(StatRow, { label: t("row.cacheHit"), value: usage.cacheHit + "%" })));
			}

			// ---- API key inventory ----
			if (props.keyInventory !== undefined) {
				const inventory = props.keyInventory;
				const list = Array.isArray(inventory.keys) ? inventory.keys : [];
				const rows = [];
				if (inventory.status !== "ready") {
					rows.push(h(StatRow, {
						key: "state",
						label: t("row.keyCount"),
						value: inventory.status === "loading" || inventory.status === "idle"
							? t("balance.loading")
							: (typeof inventory.error === "string" && inventory.error !== "" ? inventory.error : t("usage.unavailable"))
					}));
				} else {
					rows.push(h(StatRow, { key: "count", label: t("row.keyCount"), value: String(list.length) }));
					for (const entry of list) {
						const models = Array.isArray(entry.models) && entry.models.length > 0 ? entry.models.join(", ") : t("row.noModels");
						const providers = Array.isArray(entry.providers)
							? entry.providers.map((provider) => provider.provider).filter((name) => typeof name === "string" && name !== "").join(" / ")
							: "";
						const amount = entry.balance !== undefined && entry.balance.ok === true
							? formatMoney(entry.balance.total, entry.balance.currency)
							: "—";
						rows.push(h("div", { className: "dsh-tup-row", key: "k" + entry.name },
							h("span", { className: "dsh-tup-label", title: entry.name + " · " + models },
								entry.isNew === true ? h("span", { className: "dsh-tup-hit" }, t("key.new")) : null,
								props.wallet !== undefined && props.wallet.id === entry.name ? h("span", { className: "dsh-tup-current" }, t("key.current")) : null,
								" " + entry.name),
							h("span", { className: "dsh-tup-right" },
								h("span", { className: "dsh-tup-tokens" }, models.length > 30 ? models.slice(0, 30) + "…" : models),
								h("span", { className: "dsh-tup-num" }, amount))));
						rows.push(h("div", { className: "dsh-tup-heroNote", key: "d" + entry.name },
							(providers === "" ? "—" : providers) + " · " + String(entry.masked ?? "")));
					}
				}
				children.push(h(Section, { key: "keys", title: t("section.keys") }, rows));
			}

			if (context !== undefined) {
				const rows = [];
				if (context.last !== undefined) rows.push(h(StatRow, { key: "last", label: t("row.lastPrompt"), value: count(context.last) }));
				if (context.projected !== undefined) rows.push(h(StatRow, { key: "projected", label: t("row.projected"), value: count(context.projected) }));
				if (context.contextWindow !== undefined) rows.push(h(StatRow, { key: "window", label: t("row.contextWindow"), value: count(context.contextWindow) }));
				if (props.model !== undefined) rows.push(h(StatRow, { key: "model", label: t("row.model"), value: props.model }));
				if (rows.length > 0) children.push(h(Section, { key: "context", title: t("section.context") }, rows));
			}

			if (breakdown !== undefined) {
				children.push(h(Section, { key: "composition", title: t("section.composition") },
					h(StatRow, { label: t("row.system"), value: count(breakdown.system) }),
					h(StatRow, { label: t("row.tools"), value: count(breakdown.tools) }),
					h(StatRow, { label: t("row.messages"), value: count(breakdown.messages) })));
			}

			if (speed !== undefined) {
				const rows = [h(StatRow, { key: "turns", label: t("row.turns"), value: speed.turns + " / " + speed.steps })];
				if (speed.rate !== undefined) rows.push(h(StatRow, { key: "rate", label: t("row.rate"), value: speed.rate + " tok/s" }));
				if (speed.ttft !== undefined) rows.push(h(StatRow, { key: "ttft", label: t("row.ttft"), value: formatDuration(speed.ttft) }));
				if (speed.llmMs > 0) rows.push(h(StatRow, { key: "llm", label: t("row.llmTime"), value: formatDuration(speed.llmMs) }));
				if (speed.toolMs > 0) rows.push(h(StatRow, { key: "tool", label: t("row.toolTime"), value: formatDuration(speed.toolMs) }));
				children.push(h(Section, { key: "speed", title: t("section.speed") }, rows));
			}

			if (usage === undefined && context === undefined && breakdown === undefined && speed === undefined && totals === undefined) {
				children.push(h("div", { className: "dsh-tup-empty", key: "empty" }, t("empty")));
			}

			children.push(h("div", { className: "dsh-tup-accent", key: "accent" },
				h("span", { className: "dsh-tup-sectionTitle" }, t("theme.label")),
				...ACCENT_PRESETS.map((color) => h("button", {
					key: color,
					type: "button",
					className: "dsh-tup-swatch",
					"data-active": props.accent === color ? "true" : undefined,
					style: { background: color },
					title: color,
					onClick: () => {
						if (typeof props.onAccentChange === "function") props.onAccentChange(color);
					}
				})),
				h("input", {
					type: "color",
					className: "dsh-tup-color",
					value: props.accent === undefined ? "#4d6bfe" : props.accent,
					title: t("theme.custom"),
					onChange: (event) => {
						if (typeof props.onAccentChange === "function") props.onAccentChange(event.target.value);
					}
				}),
				props.accent === undefined ? null : h("button", {
					type: "button",
					className: "dsh-tup-button",
					onClick: () => {
						if (typeof props.onAccentReset === "function") props.onAccentReset();
					}
				}, t("theme.reset"))));

			children.push(h("div", { className: "dsh-tup-accent", key: "opacity" },
				h("span", { className: "dsh-tup-sectionTitle" }, t("theme.opacity")),
				h("span", { className: "dsh-tup-alpha" },
					h("input", {
						type: "range",
						className: "dsh-tup-range",
						min: "20",
						max: "100",
						step: "5",
						value: String(Math.round(opacityPanel * 100)),
						"aria-label": t("theme.opacity"),
						onChange: (event) => {
							if (typeof props.onOpacityChange === "function") props.onOpacityChange("panel", Number(event.target.value) / 100);
						}
					}),
					h("span", { className: "dsh-tup-alphaValue" }, Math.round(opacityPanel * 100) + "%")),
				hiddenOpacity ? null : h("button", {
					type: "button",
					className: "dsh-tup-button",
					onClick: () => {
						if (typeof props.onOpacityReset === "function") props.onOpacityReset();
					}
				}, t("theme.reset"))));

			children.push(h("div", { className: "dsh-tup-rule", key: "rule" }));
			children.push(h("div", { className: "dsh-tup-foot", key: "foot" }, t("foot.note")));
			children.push(h("div", { className: "dsh-tup-actions", key: "actions" },
				h("button", {
					type: "button",
					className: "dsh-tup-button",
					onClick: () => {
						if (typeof props.onRefresh === "function") props.onRefresh();
					}
				}, props.keyInventory !== undefined && props.keyInventory.refreshing === true ? t("balance.loading") : t("action.refresh")),
				h("button", { type: "button", className: "dsh-tup-button", onClick: copy }, copied ? t("action.copied") : t("action.copy"))));

			return h("div", {
				className: "dsh-tup-panel",
				ref: props.panelRef,
				style: props.style,
				role: "dialog",
				"aria-label": t("panel.title"),
				"data-token-usage-panel": ""
			}, children);
		}

		/**
		 * Header chip: all-session tokens, this-session tokens, official balance.
		 *
		 * Standard props: `useProjection`, `useSession`, plus this plugin's
		 * `useUsageSummary` / `useKeyInventory` and the `refresh*` callbacks.
		 * callbacks.
		 */
		function TokenUsageAction(props) {
			const t = props.t;
			const locale = typeof props.getLocale === "function" ? props.getLocale() : "zh";
			const count = (value) => formatCount(value, locale);
			const viewportWidth = useViewportWidth();
			const scale = uiScale(viewportWidth);
			const project = typeof props.useProjection === "function" ? props.useProjection : INERT_PROJECTION;
			const usageRaw = project("tokenUsage");
			const pressureRaw = project("contextPressure");
			const breakdownRaw = project("contextBreakdown");
			const statsRaw = project("sessionStats");
			const selectionRaw = project("modelSelection");
			const selectSession = typeof props.useSession === "function" ? props.useSession : INERT_SELECT;
			const running = selectSession((snapshot) => snapshot.running === true);
			const selectUsage = typeof props.useUsageSummary === "function" ? props.useUsageSummary : INERT_PROJECTION;
			const usageSummary = selectUsage((snapshot) => snapshot);
			const selectKeys = typeof props.useKeyInventory === "function" ? props.useKeyInventory : INERT_PROJECTION;
			const keyInventory = selectKeys((snapshot) => snapshot);
			const selectAccent = typeof props.useAccent === "function" ? props.useAccent : INERT_PROJECTION;
			const accentState = selectAccent((snapshot) => snapshot);
			const accent = accentState === undefined || accentState === null ? undefined : accentState.accent;
			const selectOpacity = typeof props.useOpacity === "function" ? props.useOpacity : INERT_PROJECTION;
			const opacityState = selectOpacity((snapshot) => snapshot);

			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			const panelRef = React.useRef(null);
			const [position, setPosition] = React.useState(null);
			const useAnchorEffect = typeof window !== "undefined" && typeof window.document !== "undefined" ? React.useLayoutEffect : React.useEffect;

			React.useEffect(() => {
				if (typeof props.ensureUsage === "function") props.ensureUsage();
				if (typeof props.ensureKeyInventory === "function") props.ensureKeyInventory();
			}, []);

			useAnchorEffect(() => {
				if (!open) {
					setPosition(null);
					return undefined;
				}
				let observer = null;
				const place = () => {
					const anchor = rootRef.current;
					if (anchor === null) return;
					setPosition(computePanelPosition(anchor.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, scale));
				};
				place();
				window.addEventListener("resize", place);
				window.addEventListener("scroll", place, true);
				if (typeof ResizeObserver === "function" && rootRef.current !== null) {
					observer = new ResizeObserver(place);
					observer.observe(rootRef.current);
				}
				return () => {
					window.removeEventListener("resize", place);
					window.removeEventListener("scroll", place, true);
					if (observer !== null) observer.disconnect();
				};
			}, [open]);

			React.useEffect(() => {
				if (!open) return undefined;
				if (typeof props.ensureUsage === "function") props.ensureUsage();
				if (typeof props.ensureKeyInventory === "function") props.ensureKeyInventory();
				const onPointerDown = (event) => {
					const target = event.target;
					if (rootRef.current !== null && rootRef.current.contains(target)) return;
					if (panelRef.current !== null && panelRef.current.contains(target)) return;
					setOpen(false);
				};
				const onKeyDown = (event) => {
					if (event.key === "Escape") setOpen(false);
				};
				document.addEventListener("pointerdown", onPointerDown, true);
				document.addEventListener("keydown", onKeyDown);
				return () => {
					document.removeEventListener("pointerdown", onPointerDown, true);
					document.removeEventListener("keydown", onKeyDown);
				};
			}, [open]);

			const wallets = deriveWallets(keyInventory);
			const picked = walletForSelection(wallets, selectionRaw);
			const wallet = picked === undefined ? undefined : picked.wallet;
			const usage = deriveUsage(usageRaw);
			const context = deriveContext(pressureRaw);
			const breakdown = deriveBreakdown(breakdownRaw);
			const speed = deriveSpeed(statsRaw);

			const summary = usageSummary === undefined || usageSummary === null ? undefined : usageSummary;
			const rows = summary === undefined || !Array.isArray(summary.rows) ? [] : summary.rows;
			const totals = summary === undefined ? undefined : summary.totals;

			if (usage === undefined && context === undefined && breakdown === undefined && speed === undefined && totals === undefined) return null;

			const allTokens = totals === undefined ? undefined : totals.usage.total;
			const sessionTokens = usage === undefined ? undefined : usage.total;
			const allText = allTokens === undefined ? "—" : count(allTokens);
			const sessionText = sessionTokens === undefined ? "—" : count(sessionTokens);
			const currency = wallet === undefined ? "CNY" : wallet.currency;
			const balanceText = wallet === undefined ? t("pill.balanceUnknown") : formatMoney(wallet.total, currency);
			const walletTag = wallet === undefined ? "" : wallet.name.replace(/_API_KEY$/u, "").replace(/^DEEPSEEK$/u, "DS");
			const modelLabel = selectionRaw === undefined || selectionRaw === null ? undefined : (selectionRaw.next ?? selectionRaw.lastUsed);
			const model = modelLabel === undefined || modelLabel === null ? undefined : modelLabel.provider + "/" + modelLabel.model;

			return h("span", { className: "dsh-tup-anchor", ref: rootRef, style: Object.assign({ "--dsh-tup-scale": String(scale) }, opacityStyle(opacityState), accentStyle(accent) ?? {}) },
				h("button", {
					type: "button",
					className: "dsh-tup-trigger",
					"data-open": open ? "true" : "false",
					"data-token-usage-trigger": "",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": t("pill.aria", { all: allText, session: sessionText, balance: balanceText }),
					title: t("pill.title"),
					onClick: () => setOpen(!open)
				},
					h("span", { className: "dsh-tup-dot", "data-live": running ? "true" : undefined }),
					h("span", { className: "dsh-tup-tokensMain" }, balanceText),
					walletTag === "" ? null : h("span", { className: "dsh-tup-tag", "data-role": "wallet" }, walletTag),
					h("span", { className: "dsh-tup-sub", "data-role": "tokens" }, t("pill.tokens", { tokens: allText }))),
				open && position !== null && typeof document !== "undefined"
					? ReactDOM.createPortal(
						h(UsagePanel, {
							t,
							usage,
							context,
							breakdown,
							speed,
							wallet,
							wallets,
							selection: modelLabel,
							totals,
							sessions: rows,
							keyInventory,
							model,
							accent,
							getLocale: () => locale,
							panelRef,
							style: Object.assign({ "--dsh-tup-scale": String(scale) }, position, opacityStyle(opacityState), accentStyle(accent) ?? {}),
							onRefresh: () => {
								if (typeof props.refreshUsage === "function") props.refreshUsage();
								if (typeof props.refreshKeyInventory === "function") props.refreshKeyInventory();
							},
							onAccentChange: (value) => {
								if (typeof props.setAccent === "function") props.setAccent(value);
							},
							onAccentReset: () => {
								if (typeof props.resetAccent === "function") props.resetAccent();
							},
							opacity: opacityState,
							onOpacityChange: (kind, value) => {
								if (typeof props.setOpacity === "function") props.setOpacity(kind, value);
							},
							onOpacityReset: () => {
								if (typeof props.resetOpacity === "function") props.resetOpacity();
							}
						}),
						document.body)
					: null);
		}
		//#endregion

		//#region plugin
		/** Required client services: the slot registry, dictionaries, and the Remote proxy. */
		const inject = ["slots", "locale", "remote"];

		/**
		 * Client plugin body: dictionaries, stylesheet, stores, and the header chip.
		 * @param ctx - client root context.
		 */
		function apply(ctx) {
			injectStyle();
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "token-usage-panel: dictionaries");
			const usage = createUsageStore(ctx);
			const keys = createKeysStore();
			const accent = createAccentStore();
			const opacity = createOpacityStore();
			ctx.effect(() => () => {
				usage.dispose();
				keys.dispose();
				accent.dispose();
				opacity.dispose();
			}, "token-usage-panel: stores");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: SLOT_ID,
				order: 30,
				label: () => "Token usage and balance",
				locale: NS,
				inject: () => ({
					hooks: {
						usageSummary: usage,
						keyInventory: keys,
						accent,
						opacity
					},
					setOpacity: (kind, value) => {
						opacity.set(kind, value);
					},
					resetOpacity: () => {
						opacity.reset();
					},
					setAccent: (value) => {
						accent.set(value);
					},
					resetAccent: () => {
						accent.reset();
					},
					refreshKeyInventory: () => {
						void keys.refresh();
					},
					ensureKeyInventory: () => {
						void keys.ensureFresh();
					},
					refreshUsage: () => {
						void usage.refresh();
					},
					ensureUsage: () => {
						void usage.ensureFresh();
					},
					getLocale: () => {
						try {
							return ctx.locale.getSnapshot().active;
						} catch (error) {
							return "zh";
						}
					}
				})
			}, TokenUsageAction));
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		exports.TokenUsageAction = TokenUsageAction;
		exports.UsagePanel = UsagePanel;
		exports.deriveUsage = deriveUsage;
		exports.deriveContext = deriveContext;
		exports.deriveBreakdown = deriveBreakdown;
		exports.deriveSpeed = deriveSpeed;
		exports.uiScale = uiScale;
		exports.computePanelPosition = computePanelPosition;
		exports.deriveWallets = deriveWallets;
		exports.walletForSelection = walletForSelection;
		exports.sumUsageRows = sumUsageRows;
		exports.buildSummary = buildSummary;
		exports.formatCompact = formatCompact;
		exports.formatExact = formatExact;
		exports.formatCount = formatCount;
		exports.formatAmount = formatAmount;
		exports.formatDuration = formatDuration;
		exports.dictionaries = { zh, en };
		return module.exports;
	}
});