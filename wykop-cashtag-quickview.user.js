// ==UserScript==
// @name         Wykop Cashtag Quickview
// @namespace    https://wykop.pl/
// @version      1.1.0
// @description  Hover over $TICKER cashtags on wykop.pl — get price data without leaving the page like a normal person
// @author       Jitsu
// @match        https://wykop.pl/*
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      query1.finance.yahoo.com
// @connect      query2.finance.yahoo.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // $AAPL, $TSLA, $BTC-USD, $PKN.WA — the whole degenerate zoo
    // optional exchange suffix: dot or dash + up to 3 letters
    const CASHTAG_RE = /\$([A-Z]{1,6}(?:[.-][A-Z]{1,3})?)\b/g;
    const cache = new Map(); // ticker -> { ts, data, error } — because hitting Yahoo 100× is not a personality
    const CACHE_TTL = 60_000; // 60s, then we ask Yahoo again and pretend it's fresh
    const LOG = (...a) => console.log('[WQ]', ...a);

    let tooltip = null;
    let hideTimer = null;

    // -------------------------------------------------------------------------
    // Styles — dark, clean, slightly menacing
    // -------------------------------------------------------------------------
    GM_addStyle(`
        .wq-cashtag {
            color: #4a9eff;
            cursor: pointer;
            border-bottom: 1px dashed rgba(74,158,255,0.5);
            white-space: nowrap;
        }
        .wq-cashtag:hover {
            color: #6ab8ff;
            border-bottom-color: #6ab8ff;
        }

        #wq-tooltip {
            position: fixed;
            z-index: 2147483647;
            background: #16213e;
            border: 1px solid #0f3460;
            border-radius: 14px;
            padding: 14px 18px;
            min-width: 210px;
            max-width: 280px;
            box-shadow: 0 12px 40px rgba(0,0,0,0.6);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            color: #e2e8f0;
            pointer-events: none;
            opacity: 0;
            transform: translateY(4px);
            transition: opacity 0.15s ease, transform 0.15s ease;
            line-height: 1.4;
        }
        #wq-tooltip.wq-visible {
            opacity: 1;
            transform: translateY(0);
        }

        .wq-tt-header { margin-bottom: 10px; }
        .wq-tt-name {
            font-weight: 700;
            font-size: 15px;
            color: #f1f5f9;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        }
        .wq-tt-meta {
            font-size: 11px;
            color: #64748b;
            margin-top: 2px;
        }
        .wq-tt-divider {
            border: none;
            border-top: 1px solid #1e3a5f;
            margin: 10px 0;
        }
        .wq-tt-price {
            font-size: 24px;
            font-weight: 700;
            color: #f1f5f9;
            letter-spacing: -0.5px;
        }
        .wq-tt-change {
            font-size: 13px;
            font-weight: 600;
            margin-top: 3px;
        }
        .wq-tt-change.wq-up   { color: #22c55e; }
        .wq-tt-change.wq-down { color: #ef4444; }
        .wq-tt-loading {
            color: #64748b;
            font-style: italic;
            font-size: 13px;
            text-align: center;
            padding: 4px 0;
        }
        .wq-tt-error {
            color: #ef4444;
            font-size: 13px;
            text-align: center;
        }
        .wq-tt-footer {
            font-size: 10px;
            color: #334155;
            margin-top: 10px;
            text-align: right;
        }
    `);

    // -------------------------------------------------------------------------
    // Tooltip — one div to rule them all, lazily spawned
    // -------------------------------------------------------------------------
    function ensureTooltip() {
        if (tooltip) return tooltip;
        tooltip = document.createElement('div');
        tooltip.id = 'wq-tooltip';
        document.body.appendChild(tooltip);
        return tooltip;
    }

    function positionTooltip(tt, anchorEl) {
        const rect = anchorEl.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const TT_W = 230;
        const TT_H = 130;

        let left = rect.left;
        let top = rect.bottom + 10;

        if (left + TT_W > vw - 8) left = vw - TT_W - 8;
        if (top + TT_H > vh - 8) top = rect.top - TT_H - 10;

        tt.style.left = Math.max(8, left) + 'px';
        tt.style.top = Math.max(8, top) + 'px';
    }

    function formatMarketCap(cap) {
        if (!cap) return '';
        if (cap >= 1e12) return `$${(cap / 1e12).toFixed(2)}T MC`;
        if (cap >= 1e9)  return `$${(cap / 1e9).toFixed(2)}B MC`;
        if (cap >= 1e6)  return `$${(cap / 1e6).toFixed(0)}M MC`;
        return '';
    }

    function renderLoading(tt) {
        tt.innerHTML = '<div class="wq-tt-loading">Pytam Yahoo... trzymaj się.</div>';
        tt.classList.add('wq-visible');
    }

    function renderError(tt, msg) {
        tt.innerHTML = `<div class="wq-tt-error">${msg}</div>`;
    }

    function renderData(tt, ticker, d) {
        const up = d.change >= 0;
        const sign = up ? '+' : '';
        const dir = up ? 'wq-up' : 'wq-down';
        const mc = formatMarketCap(d.marketCap);
        const arrow = up ? '▲' : '▼';
        const currency = d.currency || 'USD';

        tt.innerHTML = `
            <div class="wq-tt-header">
                <div class="wq-tt-name">${escHtml(d.name || ticker)}</div>
                <div class="wq-tt-meta">${escHtml(ticker)}${mc ? ' · ' + mc : ''}</div>
            </div>
            <hr class="wq-tt-divider">
            <div class="wq-tt-price">${currency} ${d.price.toFixed(2)}</div>
            <div class="wq-tt-change ${dir}">${arrow} ${sign}${d.change.toFixed(2)} (${sign}${d.changePct.toFixed(2)}%)</div>
            <div class="wq-tt-footer">Yahoo Finance · ~15min opóźnienia · xD</div>
        `;
    }

    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    // -------------------------------------------------------------------------
    // Yahoo Finance — free, unofficial, could die any day, living on the edge
    // -------------------------------------------------------------------------

    // Bare metal request — no cache, no mercy, no fallback
    // Uses v8/chart — no crumb/cookie auth required unlike the v7/quote graveyard
    function yahooFetch(symbol, callback) {
        const url =
            'https://query1.finance.yahoo.com/v8/finance/chart/' +
            `${encodeURIComponent(symbol)}?interval=1d&range=1d&includePrePost=false`;

        LOG('fetch →', url);
        GM_xmlhttpRequest({
            method: 'GET',
            url,
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            },
            onload(res) {
                LOG('response', res.status, res.responseText.slice(0, 200));
                try {
                    const json = JSON.parse(res.responseText);
                    const meta = json?.chart?.result?.[0]?.meta;
                    if (!meta || meta.regularMarketPrice == null) {
                        LOG('not_found — meta:', meta);
                        callback(null, 'not_found');
                        return;
                    }
                    const price    = meta.regularMarketPrice;
                    const prev     = meta.previousClose ?? meta.chartPreviousClose ?? price;
                    const change   = price - prev;
                    const changePct = prev ? (change / prev) * 100 : 0;
                    callback({
                        name:      meta.longName || meta.shortName || symbol,
                        price,
                        change,
                        changePct,
                        marketCap: meta.marketCap,
                        currency:  meta.currency,
                    }, null);
                } catch (e) {
                    LOG('parse error:', e);
                    callback(null, 'parse_error');
                }
            },
            onerror(e) { LOG('network error:', e); callback(null, 'network_error'); },
        });
    }

    const ERROR_MESSAGES = {
        not_found:     'Nie istnieje. Literówka? Skill issue.',
        parse_error:   'Yahoo zwrócił śmieci. Klasyk.',
        network_error: 'Brak sieci. Wyjdź z piwnicy.',
    };

    // Cache + GPW auto-fallback — tries global first, sneaks in .WA if that flops
    function fetchQuote(ticker, callback) {
        const entry = cache.get(ticker);
        if (entry && Date.now() - entry.ts < CACHE_TTL) {
            callback(entry.data, entry.error); // cache hit, you're welcome
            return;
        }

        yahooFetch(ticker, (data, err) => {
            // Flopped globally? Maybe it's a GPW peasant stock — retry with .WA
            if (err === 'not_found' && !ticker.includes('.') && !ticker.includes('-')) {
                yahooFetch(ticker + '.WA', (data2) => {
                    if (data2) {
                        // GPW to the rescue — Polska gurom
                        cache.set(ticker, { ts: Date.now(), data: data2, error: null });
                        callback(data2, null);
                    } else {
                        // Absolutely nothing. Made up ticker? Crypto rugpull? Who knows.
                        const msg = ERROR_MESSAGES[err] || err;
                        cache.set(ticker, { ts: Date.now(), data: null, error: msg });
                        callback(null, msg);
                    }
                });
                return;
            }

            const msg = err ? (ERROR_MESSAGES[err] || err) : null;
            cache.set(ticker, { ts: Date.now(), data: data || null, error: msg });
            callback(data || null, msg);
        });
    }

    // -------------------------------------------------------------------------
    // Hover — show up, fetch, get out
    // -------------------------------------------------------------------------
    function onEnter(e) {
        clearTimeout(hideTimer);
        const span = e.currentTarget;
        const ticker = span.dataset.ticker;
        LOG('hover →', ticker);
        const tt = ensureTooltip();
        positionTooltip(tt, span);
        renderLoading(tt);

        fetchQuote(ticker, (data, err) => {
            if (!tt.classList.contains('wq-visible')) return; // user already left, ghost
            if (err) { renderError(tt, err); return; }
            renderData(tt, ticker, data);
        });
    }

    function onLeave() {
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (tooltip) tooltip.classList.remove('wq-visible');
        }, 200);
    }

    // -------------------------------------------------------------------------
    // DOM scanner — hunts $TICKERS in text nodes like a bloodhound with a Bloomberg terminal
    // -------------------------------------------------------------------------
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'INPUT', 'A', 'CODE', 'PRE', 'KBD', 'BUTTON', 'SELECT']);

    function wrapTextNode(textNode) {
        const text = textNode.textContent;
        CASHTAG_RE.lastIndex = 0;
        if (!CASHTAG_RE.test(text)) return;
        CASHTAG_RE.lastIndex = 0;

        const frag = document.createDocumentFragment();
        let last = 0;
        let m;

        while ((m = CASHTAG_RE.exec(text)) !== null) {
            if (m.index > last) {
                frag.appendChild(document.createTextNode(text.slice(last, m.index)));
            }
            const span = document.createElement('span');
            span.className = 'wq-cashtag';
            span.dataset.ticker = m[1].toUpperCase();
            span.textContent = m[0];
            span.addEventListener('mouseenter', onEnter);
            span.addEventListener('mouseleave', onLeave);
            frag.appendChild(span);
            LOG('span created:', m[0]);
            last = m.index + m[0].length;
        }

        if (last < text.length) {
            frag.appendChild(document.createTextNode(text.slice(last)));
        }

        textNode.parentNode.replaceChild(frag, textNode);
    }

    function walkNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            wrapTextNode(node);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (SKIP_TAGS.has(node.tagName)) return;
        if (node.classList.contains('wq-cashtag')) return;
        if (node.dataset && node.dataset.wqScanned) return;

        if (node.dataset) node.dataset.wqScanned = '1'; // been there, done that

        // snapshot childNodes — live NodeList + DOM mutations = chaos
        Array.from(node.childNodes).forEach(walkNode);
    }

    function scan(root) {
        // Target wykop content zones — if they rename their classes again we riot
        const selectors = [
            '[class*="entry"] [class*="body"]',
            '[class*="entry"] [class*="text"]',
            '[class*="entry"] [class*="content"]',
            '[class*="comment"] [class*="body"]',
            '[class*="comment"] [class*="content"]',
            '[class*="description"]',
            '[class*="article"] [class*="content"]',
        ].join(', ');

        let targets = [];
        if (root.querySelectorAll) {
            targets = Array.from(root.querySelectorAll(selectors));
        }

        // Nothing matched — go wide, scan the whole thing, pray for no false positives
        if (targets.length === 0 && root !== document) {
            targets = [root];
        } else if (targets.length === 0 && root === document) {
            targets = [document.body];
        }

        targets.forEach(el => {
            if (!el.dataset || el.dataset.wqScanned) return;
            walkNode(el);
        });
    }

    // -------------------------------------------------------------------------
    // MutationObserver — because wykop is a SPA and the DOM never stops mutating
    // -------------------------------------------------------------------------
    const observer = new MutationObserver(mutations => {
        for (const m of mutations) {
            for (const node of m.addedNodes) {
                if (node.nodeType !== Node.ELEMENT_NODE) continue;
                scan(node);
            }
        }
    });

    LOG('script init — scanning document');
    scan(document);
    observer.observe(document.body, { childList: true, subtree: true });
    LOG('MutationObserver armed');
})();
