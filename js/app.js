const LB = {
  // Turnstile Site Key (Replace with yours)
  turnstileKey: 'YOUR_SITE_KEY',

  init() {
    window.addEventListener('hashchange', () => this.router.load());
    this.router.load();
  },

  router: {
    async load() {
      const path = window.location.hash || '#/';
      const app = document.getElementById('app');
      
      // Clear previous view
      app.innerHTML = "";

      // Turnstile Logic: Required for everything except Home
      if (path !== '#/') {
        this.renderTurnstile();
      }

      if (path === '#/') this.viewLanding();
      else if (path.startsWith('#/board')) this.viewBoard();
      else if (path.startsWith('#/person/')) this.viewPerson(path.split('/')[2]);
    },

    renderTurnstile() {
      const tsContainer = document.createElement('div');
      tsContainer.id = "ts-checker";
      tsContainer.className = "cf-turnstile";
      tsContainer.dataset.sitekey = LB.turnstileKey;
      document.getElementById('app').appendChild(tsContainer);
      // Trigger cloudflare script
      if (window.turnstile) turnstile.render('#ts-checker');
    }
  },

  render: {
    personPage(data) {
      return `
        <div class="person-detail">
          <h1>${data.name}</h1>
          <span class="status-badge status-${data.verification_status}">${data.verification_status}</span>
          <div class="claim-box">
            <h3>The Claim</h3>
            <p>${data.claim}</p>
          </div>
          <div class="truth-box">
            <h3>The Fact</h3>
            <p>${data.truth}</p>
            <a href="${data.source_url}" target="_blank" class="source-link">View Primary Source ↗</a>
          </div>
        </div>
      `;
    }
  }
};

LB.init();
