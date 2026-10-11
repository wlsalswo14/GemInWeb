/* GemInWeb — content bootstrap: adapter + panel + agent, MutationObserver + 500 ms tick. */
(function (g) {
  'use strict';
  const DSG = (g.DSG = g.DSG || {});
  if (DSG.__booted) return;
  DSG.__booted = true;

  const site = DSG.detectSite(g.location);
  if (!site) return;

  async function boot() {
    let settings = await DSG.settings.load();
    await DSG.agentStorage.loadTab();
    const adapter = DSG.createSiteAdapter(site);

    let agent = null;
    const panel = DSG.createPanel({
      site,
      onToggle: (on) => agent && agent.setOn(on),
      onStart: (text) => agent && agent.startTask(text),
      onStop: () => agent && agent.stop(),
      onResume: () => agent && agent.resume(),
      onOptions: () => DSG.openOptions(),
      onRefreshStatus: () => refreshStatus(),
      onWorkspace: (p) => agent && agent.setWorkspace(p),
      onApproval: async (mode) => {
        agent && agent.setApprovalMode(mode);
        settings = await DSG.settings.save({ approval: mode });
      },
      onResetAutoApprove: () => agent && agent.resetAutoApprove(),
      onCopyPrimer: async () => {
        try {
          const text = await agent.getPrimer('full');
          const ok = await DSG.copyText(text);
          panel.notify(ok ? `지침을 복사했습니다 (${text.length}자). Gem 지침이나 첫 메시지에 붙여 넣으세요.` : '클립보드 복사에 실패했습니다.', ok ? 'info' : 'error');
        } catch (e) {
          panel.notify(DSG.friendlyError(e), 'error');
        }
      },
      onSystemInstructions: () => agent && agent.pushSystemInstructions(),
    });
    const remount = panel.mount();
    DSG._panel = panel; // isolated-world only (E2E driver); the page cannot see DSG

    agent = DSG.createAgent({
      adapter,
      rpc: DSG.rpc,
      protocol: DSG.protocol,
      storage: DSG.agentStorage,
      settings,
      ui: panel,
    });

    if (!adapter.hasSelectors()) {
      panel.setSelectorWarning('선택자 파일(content/selectors.js)이 없거나 이 사이트 항목이 비어 있습니다 — 자동 동작이 제한됩니다.');
    } else {
      const missing = adapter.missingKeys();
      if (missing.length) panel.setSelectorWarning('누락된 선택자: ' + missing.join(', '));
    }

    DSG.settings.onChange((s) => {
      settings = s;
      agent.updateSettings(s);
    });

    async function refreshStatus() {
      panel.setConnection('busy', '호스트 확인 중…');
      try {
        const st = await DSG.rpc.status();
        const shell = st.shell ? ` · ${st.shell.kind}` : '';
        panel.setConnection('ok', `연결됨 v${st.version || '?'}${shell} (${settings.transport === 'http' ? 'HTTP' : '네이티브'})`);
        panel.setDefaultWorkspace(st.defaultWorkspace || null);
        return true;
      } catch (e) {
        panel.setConnection('err', DSG.friendlyError(e));
        return false;
      }
    }

    // Learn extra tools the host may expose (aliases stay built-in).
    refreshStatus().then((ok) => {
      if (!ok) return;
      DSG.rpc
        .tools()
        .then((r) => {
          for (const t of (r && r.tools) || []) DSG.protocol.registerTool({ name: t.name, mutating: t.mutating, bodyParam: t.bodyParam });
        })
        .catch(() => {});
    });

    await agent.init();

    // Tick: MutationObserver (throttled) + 500 ms interval.
    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        agent.tick();
      }, 200);
    };
    try {
      const mo = new MutationObserver((muts) => {
        // ignore our own panel
        for (const m of muts) {
          if (m.target === panel.host || (panel.host.contains && panel.host.contains(m.target))) continue;
          schedule();
          return;
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    } catch (_) {
      /* interval still runs */
    }
    setInterval(() => {
      remount();
      agent.tick();
    }, 500);
    setInterval(() => {
      if (document.visibilityState === 'visible') refreshStatus();
    }, 60000);
  }

  boot().catch((e) => {
    try {
      console.error('[GemInWeb] boot failed', e);
    } catch (_) {
      /* ignore */
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
