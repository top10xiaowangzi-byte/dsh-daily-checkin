window.__ModuleLoader__.load({
	id: "dsh-daily-checkin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		let react = require("react");
		react = __toESM(react, 1);
		const { useEffect, useState, useRef } = react;
		const h = react.createElement;

		const name = "dsh-daily-checkin-client";
		const inject = ["slots"];
		const iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect x="2.5" y="4" width="19" height="17" rx="4" fill="#0f172a" stroke="#22c55e" stroke-width="1.5"/><path d="M7 2.5v3.2M17 2.5v3.2" stroke="#22c55e" stroke-width="1.6" stroke-linecap="round"/><path d="M2.5 8.5h19" stroke="#22c55e" stroke-width="1.2" opacity="0.7"/><path d="m8 14.6 2.6 2.6L16.5 11" fill="none" stroke="#22c55e" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
		const icon = "data:image/svg+xml," + encodeURIComponent(iconSvg);

		const color = {
			ok: "var(--dsw-alias-state-success-primary,#22c55e)",
			warn: "var(--dsw-alias-state-warn-primary,#eab308)",
			error: "var(--dsw-alias-state-error-primary,#ef4444)",
			none: "var(--dsw-alias-label-dimmed,#64748b)"
		};
		const bgLayer = "var(--dsw-alias-bg-layer-1,#252525)";
		const borderL2 = "var(--dsw-alias-border-l2,#4a4a4a)";
		const labelPrimary = "var(--dsw-alias-label-primary,#f4f4f5)";
		const labelSecondary = "var(--dsw-alias-label-secondary,#bdbdbd)";

		// 面板挂在全局浮层 `shell.overlay` 里，不再留在会话头部：DSH 0.2.x 的会话区
		// 祖先节点带 overflow/transform，头部内的 fixed 面板会被裁掉（点开看不见）。
		const panelState = { open: false, listeners: new Set() };
		function setPanelOpen(open) {
			panelState.open = open;
			for (const listener of [...panelState.listeners]) {
				try {
					listener();
				} catch {
					/* 单个订阅者失败不影响其他 */
				}
			}
		}
		function usePanelOpen() {
			const [, force] = useState(0);
			useEffect(() => {
				const listener = () => force((value) => value + 1);
				panelState.listeners.add(listener);
				return () => {
					panelState.listeners.delete(listener);
				};
			}, []);
			return panelState.open;
		}

		const stateText = (row) => {
			if (row.state === "failed") return "失败：" + (row.error ?? "请稍后重试");
			if (typeof row.detail === "string" && row.detail) return row.detail;
			if (row.state === "signed") return "已签到" + (row.credit === void 0 ? "" : " +" + row.credit);
			return "今天已签到";
		};
		const stateColor = (row) => row.state === "failed" ? color.error : labelSecondary;

		function App() {
			const [data, setData] = useState();
			const open = usePanelOpen();
			const [toast, setToast] = useState();
			const [retrying, setRetrying] = useState(false);
			const [loading, setLoading] = useState(false);
			const [queryError, setQueryError] = useState();
			const requestId = useRef(0);

			const refresh = async (notify, path, init) => {
				const id = ++requestId.current;
				setLoading(true);
				setQueryError(void 0);
				try {
					const response = await fetch(path || "/daily-checkin/status", {
						...(init || {}),
						signal: AbortSignal.timeout(2e4)
					});
					if (!response.ok) throw new Error("HTTP " + response.status);
					const d = await response.json();
					if (!d || typeof d !== "object" || !Array.isArray(d.results)) throw new Error("unexpected status shape");
					if (id !== requestId.current) return;
					setData(d);
					if (notify && d.notice) setToast(d.notice);
				} catch {
					if (id !== requestId.current) return;
					setQueryError("查询失败，请重新打开面板重试；当前显示上次记录");
					setData((previous) => previous ?? { status: "error", results: [] });
				} finally {
					if (id === requestId.current) setLoading(false);
				}
			};

			useEffect(() => {
				refresh(true, "/daily-checkin/status");
			}, []);
			useEffect(() => {
				if (open) void refresh(false);
			}, [open]);
			useEffect(() => {
				if (!toast) return;
				const id = window.setTimeout(() => setToast(void 0), 6e3);
				return () => window.clearTimeout(id);
			}, [toast]);

			const retry = async () => {
				setRetrying(true);
				try {
					await refresh(false, "/daily-checkin/status", { method: "POST" });
				} finally {
					setRetrying(false);
				}
			};

			if (!data || data.status === "none" || !Array.isArray(data.results)) return null;
			const failed = data.results.some((row) => row.state === "failed");

			const toastEl = toast ? h("div", {
				style: {
					position: "fixed",
					zIndex: 1001,
					right: 20,
					top: 18,
					padding: "8px 12px",
					borderRadius: 8,
					background: bgLayer,
					border: "1px solid " + (color[data.status] || color.none),
					color: labelPrimary,
					boxShadow: "0 8px 24px #0008",
					fontSize: 13
				}
			}, toast) : null;

			const rows = data.results.map((row) => h("div", {
				key: row.uid,
				style: { padding: "7px 0", borderTop: "1px solid " + borderL2 }
			}, h("div", { style: { display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 } },
				h("b", {
					style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }
				}, row.nickname ?? row.uid),
				h("span", {
					style: {
						fontSize: 12,
						color: stateColor(row),
						overflow: "hidden",
						textOverflow: "ellipsis",
						whiteSpace: "nowrap"
					}
				}, stateText(row))
			)));

			const retryButton = failed ? h("button", {
				disabled: retrying,
				onClick: () => void retry(),
				style: {
					marginTop: 8,
					width: "100%",
					padding: "6px 8px",
					borderRadius: 6,
					border: "1px solid " + borderL2,
					background: "transparent",
					color: "inherit",
					cursor: retrying ? "wait" : "pointer",
					fontSize: 13
				}
			}, retrying ? "正在重试…" : "重试失败项") : null;

			const panel = open ? h("div", {
				style: {
					position: "fixed",
					zIndex: 1e3,
					width: 320,
					right: 20,
					top: 72,
					background: bgLayer,
					border: "1px solid " + borderL2,
					borderRadius: 10,
					padding: 12,
					boxShadow: "0 18px 45px #0008",
					color: labelPrimary,
					fontSize: 13
				}
			}, h("button", {
				onClick: () => setPanelOpen(false),
				"aria-label": "关闭",
				style: {
					float: "right",
					background: "transparent",
					border: 0,
					color: labelSecondary,
					fontSize: 19,
					cursor: "pointer",
					lineHeight: 1
				}
			}, "×"), h("b", { style: { display: "flex", alignItems: "center", gap: 6, fontSize: 14 } },
				h("img", { src: icon, style: { width: 16, height: 16 } }),
				"每日签到（WorkBuddy / 灵犀 / Qoder）"
			), h("div", { style: { color: labelSecondary, fontSize: 12, margin: "7px 0" } },
				"本次启动检查：",
				data.checkedAt ? new Date(data.checkedAt).toLocaleString() : "—"
			), loading ? h("div", { role: "status" }, "正在查询…") : null, queryError ? h("div", { role: "alert" }, queryError) : null, h("div", { style: { maxHeight: 160, overflowY: "auto" } }, rows), retryButton) : null;

			return h(react.Fragment, null, toastEl, panel);
		}

		/** 会话头部的「(n)」按钮：只切换面板并显示状态点，面板在 shell.overlay 里。 */
		function HeaderToggle() {
			const open = usePanelOpen();
			const [data, setData] = useState();
			useEffect(() => {
				let alive = true;
				const load = async () => {
					try {
						const response = await fetch("/daily-checkin/status", { signal: AbortSignal.timeout(20000) });
						const payload = await response.json();
						if (alive && payload && payload.ok !== false) setData(payload);
					} catch {
						/* 读不到就保持上一个状态 */
					}
				};
				void load();
				const timer = window.setInterval(load, 60000);
				return () => {
					alive = false;
					window.clearInterval(timer);
				};
			}, []);
			if (!data || data.status === "none" || !Array.isArray(data.results)) return null;
			return h("button", {
				onClick: () => setPanelOpen(!open),
				title: "每日签到（WorkBuddy / 灵犀 / Qoder）",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: 4,
					border: 0,
					background: open ? "var(--dsw-alias-interactive-bg-hover, transparent)" : "transparent",
					color: "inherit",
					fontSize: 12,
					cursor: "pointer",
					padding: "2px 4px",
					borderRadius: 6
				}
			}, h("img", { src: icon, alt: "每日签到", style: { width: 16, height: 16 } }), h("span", null, "(", data.results.length, ")"), h("i", {
				style: {
					width: 7,
					height: 7,
					borderRadius: "50%",
					background: color[data.status] || color.none
				}
			}));
		}

		function apply(ctx) {
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "daily-checkin-header",
				order: 22
			}, HeaderToggle));
			ctx.slots.inject("shell.overlay", () => ctx.slots.register({
				name: "shell.overlay",
				id: "daily-checkin-panel",
				order: 125
			}, App));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
