(function goodosAccountSettings() {
  "use strict";

  if (window.__goodosAccountSettingsV1) return;
  window.__goodosAccountSettingsV1 = true;

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function initials(value) {
    var parts = String(value || "GoodOS").trim().split(/\s+/).filter(Boolean);
    return parts.slice(0, 2).map(function (part) { return part.charAt(0).toUpperCase(); }).join("") || "G";
  }

  function selected(value, expected) {
    return String(value || "") === expected ? " selected" : "";
  }

  function checked(value) {
    return value ? " checked" : "";
  }

  function imageMarkup(url, label, className) {
    if (url) {
      return '<div class="' + className + '"><img src="' + esc(url) + '" alt="' + esc(label) + '" /></div>';
    }
    return '<div class="' + className + '">' + esc(initials(label)) + '</div>';
  }

  function accountTabs(active) {
    return [
      '<div class="account-tabs">',
      '<button type="button" class="' + (active === "profile" ? "active" : "") + '" onclick="window.openAccountView(\'profile\')">User Profile</button>',
      '<button type="button" class="' + (active === "business-profile" ? "active" : "") + '" onclick="window.openAccountView(\'business-profile\')">Business Profile</button>',
      '<button type="button" class="' + (active === "preferences" ? "active" : "") + '" onclick="window.openAccountView(\'preferences\')">Preferences &amp; Security</button>',
      '</div>'
    ].join("");
  }

  function statusBox() {
    return '<div class="account-status" id="accountStatus" role="status"></div>';
  }

  function loadingView(active, title, description) {
    scheduleLoad();
    return [
      typeof hero === "function" ? hero(title, description) : "",
      '<div class="account-shell">',
      accountTabs(active),
      statusBox(),
      '<div class="account-card"><p class="account-muted">Loading your live account settings…</p></div>',
      '</div>'
    ].join("");
  }

  function errorView(active, title, description) {
    return [
      typeof hero === "function" ? hero(title, description) : "",
      '<div class="account-shell">',
      accountTabs(active),
      '<div class="account-card">',
      '<h3>Settings could not be loaded</h3>',
      '<p class="account-muted">' + esc(state.accountSettingsError || "Unknown settings error.") + '</p>',
      '<button class="account-action primary" type="button" onclick="window.loadAccountSettings(true)">Try Again</button>',
      '</div>',
      '</div>'
    ].join("");
  }

  function scheduleLoad() {
    if (state.accountSettingsLoading) return;
    state.accountSettingsLoading = true;
    setTimeout(function () { window.loadAccountSettings(false); }, 0);
  }

  function renderAccount() {
    if (typeof render === "function") render();
  }

  function showStatus(message, isError) {
    var target = document.getElementById("accountStatus");
    if (!target) return;
    target.textContent = message;
    target.classList.toggle("error", Boolean(isError));
    target.style.display = "block";
  }

  async function upload(path, field, file) {
    var form = new FormData();
    form.append(field, file);
    var response = await fetch(path, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      body: form
    });
    var payload = await response.json().catch(function () { return {}; });
    if (!response.ok || payload.success === false) {
      throw new Error(payload.message || "Upload failed.");
    }
    return payload;
  }

  window.loadAccountSettings = async function loadAccountSettings(force) {
    if (state.accountSettingsLoaded && !force) return state.accountOverview;
    state.accountSettingsLoading = true;
    state.accountSettingsError = "";
    try {
      var payload = await request("/api/settings/overview?t=" + Date.now());
      state.accountOverview = payload.data || payload;
      state.accountSettingsLoaded = true;
      state.accountSettingsLoading = false;
      if (state.accountOverview.profile) {
        state.user = Object.assign({}, state.user || {}, state.accountOverview.profile);
      }
      window.goodosUpdateUserPill();
      renderAccount();
      return state.accountOverview;
    } catch (error) {
      state.accountSettingsLoading = false;
      state.accountSettingsLoaded = false;
      state.accountSettingsError = error.message || "Failed to load account settings.";
      renderAccount();
      return null;
    }
  };

  window.goodosUpdateUserPill = function goodosUpdateUserPill() {
    var pill = document.getElementById("userPill");
    var user = state.user || {};
    if (!pill) return;
    var fullName = [user.firstName, user.lastName].filter(Boolean).join(" ");
    var name = user.displayName || user.fullName || fullName || user.email || "Account";
    var role = user.platformRole || "user";
    pill.innerHTML =
      '<span style="position:relative;display:inline-flex">' +
      imageMarkup(user.avatarUrl, name, "account-pill-avatar") +
      '<span class="topbar-status-dot" aria-label="Online"></span></span>' +
      '<span class="topbar-user-copy"><span class="topbar-user-name" id="userPillName">' + esc(name) + '</span>' +
      '<span class="topbar-user-role" id="userPillRole">◇ ' + esc(String(role).toUpperCase()) + '</span></span>' +
      '<svg class="topbar-user-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 10 5 5 5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    pill.setAttribute("aria-label", name + " account");
    pill.title = name;
  };

  window.openAccountView = function openAccountView(view) {
    state.view = view;
    document.querySelectorAll("[data-view]").forEach(function (button) {
      button.classList.toggle("active", button.dataset.view === view);
    });
    renderAccount();
  };

  window.goodosUserProfileView = function goodosUserProfileView() {
    if (state.accountSettingsError && !state.accountSettingsLoaded) {
      return errorView("profile", "User Profile", "Manage your identity, profile photo, account details, and active sessions.");
    }
    if (!state.accountSettingsLoaded || !state.accountOverview) {
      return loadingView("profile", "User Profile", "Manage your identity, profile photo, account details, and active sessions.");
    }

    var data = state.accountOverview;
    var profile = data.profile || state.user || {};
    var sessions = Array.isArray(data.sessions) ? data.sessions : [];
    var displayName = profile.displayName || profile.email || "GoodOS User";

    return [
      hero("User Profile", "Manage your identity, profile photo, account details, and active sessions."),
      '<div class="account-shell">',
      accountTabs("profile"),
      statusBox(),
      '<div class="account-layout">',
      '<section class="account-card account-identity">',
      imageMarkup(profile.avatarUrl, displayName, "account-avatar"),
      '<div><h3>' + esc(displayName) + '</h3><p class="account-muted">' + esc(profile.email || "") + '</p></div>',
      '<div class="account-badge-row"><span class="badge">' + esc(profile.platformRole || "user") + '</span><span class="badge">' + (profile.emailVerified ? "Verified" : "Unverified") + '</span><span class="badge">MFA ' + (profile.mfaEnabled ? "Enabled" : "Off") + '</span></div>',
      '<input id="accountAvatarFile" type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="window.uploadUserAvatar(this)" />',
      '<div class="account-actions"><button class="account-action primary" type="button" onclick="document.getElementById(\'accountAvatarFile\').click()">Upload Photo</button>',
      profile.avatarUrl ? '<button class="account-action danger" type="button" onclick="window.removeUserAvatar()">Remove</button>' : '',
      '</div><p class="account-muted">JPEG, PNG, or WebP. Maximum 2 MB.</p>',
      '</section>',
      '<section class="account-card"><h3>Personal Information</h3><p class="account-muted">This information is shared across your GoodOS applications.</p>',
      '<div class="account-form-grid">',
      '<div class="account-field"><label for="profileFirstName">First name</label><input id="profileFirstName" value="' + esc(profile.firstName || "") + '" maxlength="100" /></div>',
      '<div class="account-field"><label for="profileLastName">Last name</label><input id="profileLastName" value="' + esc(profile.lastName || "") + '" maxlength="100" /></div>',
      '<div class="account-field full"><label for="profileDisplayName">Display name</label><input id="profileDisplayName" value="' + esc(profile.displayName || "") + '" maxlength="160" /></div>',
      '<div class="account-field"><label>Email</label><input value="' + esc(profile.email || "") + '" disabled /></div>',
      '<div class="account-field"><label for="profilePhone">Phone</label><input id="profilePhone" value="' + esc(profile.phone || "") + '" maxlength="50" autocomplete="tel" /></div>',
      '</div><div class="account-actions" style="margin-top:18px"><button class="account-action primary" type="button" onclick="window.saveUserProfile()">Save Profile</button><button class="account-action" type="button" onclick="window.loadAccountSettings(true)">Refresh</button></div>',
      '</section></div>',
      '<section class="account-card"><div class="section-head"><h3>Active Sessions</h3><span class="badge">' + sessions.length + ' Active</span></div>',
      '<table><thead><tr><th>Device</th><th>IP Address</th><th>Authentication</th><th>Last Seen</th><th>Action</th></tr></thead><tbody>',
      sessions.map(function (session) {
        return '<tr><td><strong>' + esc(session.deviceLabel || "Browser session") + '</strong><div class="account-muted">' + esc(session.userAgent || "Unknown client") + '</div></td><td>' + esc(session.ipAddress || "-") + '</td><td>' + esc(session.authLevel || "password") + (session.mfaVerified ? ' + MFA' : '') + '</td><td>' + (session.lastSeenAt ? esc(new Date(session.lastSeenAt).toLocaleString()) : "-") + '</td><td>' + (session.isCurrent ? '<span class="account-session-current">Current</span>' : '<button class="account-action danger" type="button" onclick="window.revokeAccountSession(\'' + esc(session.id) + '\')">Revoke</button>') + '</td></tr>';
      }).join("") || '<tr><td colspan="5" class="account-muted">No active sessions found.</td></tr>',
      '</tbody></table></section>',
      '</div>'
    ].join("");
  };

  window.goodosBusinessProfileView = function goodosBusinessProfileView() {
    if (state.accountSettingsError && !state.accountSettingsLoaded) {
      return errorView("business-profile", "Business Profile", "Manage your organization identity, logo, contact information, and workspace details.");
    }
    if (!state.accountSettingsLoaded || !state.accountOverview) {
      return loadingView("business-profile", "Business Profile", "Manage your organization identity, logo, contact information, and workspace details.");
    }

    var data = state.accountOverview;
    var organization = data.organization || {};
    var workspace = data.workspace || {};
    var businessName = organization.name || "GoodOS";

    return [
      hero("Business Profile", "Manage your organization identity, logo, contact information, and workspace details."),
      '<div class="account-shell">',
      accountTabs("business-profile"),
      statusBox(),
      '<div class="account-layout">',
      '<section class="account-card account-identity">',
      imageMarkup(organization.logoUrl, businessName, "business-logo"),
      '<div><h3>' + esc(businessName) + '</h3><p class="account-muted">' + esc(organization.slug || "") + '</p></div>',
      '<div class="account-badge-row"><span class="badge">' + esc(organization.plan || "enterprise") + '</span><span class="badge">' + esc(organization.role || "member") + '</span><span class="badge">' + esc(organization.status || "active") + '</span></div>',
      '<input id="businessLogoFile" type="file" accept="image/jpeg,image/png,image/webp" hidden onchange="window.uploadBusinessLogo(this)" />',
      '<div class="account-actions"><button class="account-action primary" type="button" onclick="document.getElementById(\'businessLogoFile\').click()">Upload Logo</button>',
      organization.logoUrl ? '<button class="account-action danger" type="button" onclick="window.removeBusinessLogo()">Remove</button>' : '',
      '</div><p class="account-muted">JPEG, PNG, or WebP. Maximum 4 MB.</p>',
      '</section>',
      '<section class="account-card"><h3>Business Information</h3><p class="account-muted">Used throughout GoodOS administrative and customer-facing experiences.</p>',
      '<div class="account-form-grid">',
      '<div class="account-field"><label for="businessName">Business name</label><input id="businessName" value="' + esc(organization.name || "") + '" maxlength="100" /></div>',
      '<div class="account-field"><label for="businessLegalName">Legal name</label><input id="businessLegalName" value="' + esc(organization.legalName || "") + '" maxlength="200" /></div>',
      '<div class="account-field"><label for="businessEmail">Business email</label><input id="businessEmail" type="email" value="' + esc(organization.businessEmail || "") + '" maxlength="320" /></div>',
      '<div class="account-field"><label for="businessSupportEmail">Support email</label><input id="businessSupportEmail" type="email" value="' + esc(workspace.supportEmail || "") + '" maxlength="320" /></div>',
      '<div class="account-field"><label for="businessPhone">Phone</label><input id="businessPhone" value="' + esc(organization.phone || "") + '" maxlength="50" /></div>',
      '<div class="account-field"><label for="businessWebsite">Website</label><input id="businessWebsite" type="url" value="' + esc(organization.websiteUrl || "") + '" maxlength="500" placeholder="https://" /></div>',
      '<div class="account-field"><label for="businessIndustry">Industry</label><input id="businessIndustry" value="' + esc(organization.industry || "") + '" maxlength="120" /></div>',
      '<div class="account-field"><label for="businessSize">Company size</label><select id="businessSize"><option value="">Select</option><option value="1"' + selected(organization.companySize, "1") + '>Just me</option><option value="2-10"' + selected(organization.companySize, "2-10") + '>2–10</option><option value="11-50"' + selected(organization.companySize, "11-50") + '>11–50</option><option value="51-200"' + selected(organization.companySize, "51-200") + '>51–200</option><option value="201-1000"' + selected(organization.companySize, "201-1000") + '>201–1,000</option><option value="1000+"' + selected(organization.companySize, "1000+") + '>1,000+</option></select></div>',
      '<div class="account-field full"><label for="businessDescription">Description</label><textarea id="businessDescription" maxlength="1000">' + esc(workspace.description || "") + '</textarea></div>',
      '<div class="account-field full"><label for="businessAddress1">Address</label><input id="businessAddress1" value="' + esc(organization.addressLine1 || "") + '" maxlength="200" /></div>',
      '<div class="account-field full"><label for="businessAddress2">Address line 2</label><input id="businessAddress2" value="' + esc(organization.addressLine2 || "") + '" maxlength="200" /></div>',
      '<div class="account-field"><label for="businessCity">City</label><input id="businessCity" value="' + esc(organization.city || "") + '" maxlength="120" /></div>',
      '<div class="account-field"><label for="businessRegion">State / region</label><input id="businessRegion" value="' + esc(organization.region || "") + '" maxlength="120" /></div>',
      '<div class="account-field"><label for="businessPostal">Postal code</label><input id="businessPostal" value="' + esc(organization.postalCode || "") + '" maxlength="30" /></div>',
      '<div class="account-field"><label for="businessCountry">Country code</label><input id="businessCountry" value="' + esc(organization.countryCode || "") + '" maxlength="2" placeholder="US" /></div>',
      '</div><div class="account-actions" style="margin-top:18px"><button class="account-action primary" type="button" onclick="window.saveBusinessProfile()">Save Business Profile</button><button class="account-action" type="button" onclick="window.loadAccountSettings(true)">Refresh</button></div>',
      '</section></div></div>'
    ].join("");
  };

  window.goodosPreferencesView = function goodosPreferencesView() {
    if (state.accountSettingsError && !state.accountSettingsLoaded) {
      return errorView("preferences", "My Settings", "Personalize GoodOS, manage notifications, update your password, and export account data.");
    }
    if (!state.accountSettingsLoaded || !state.accountOverview) {
      return loadingView("preferences", "My Settings", "Personalize GoodOS, manage notifications, update your password, and export account data.");
    }

    var preferences = state.accountOverview.preferences || {};
    return [
      hero("My Settings", "Personalize GoodOS, manage notifications, update your password, and export account data."),
      '<div class="account-shell">', accountTabs("preferences"), statusBox(),
      '<section class="account-card"><h3>Appearance &amp; Regional Settings</h3><div class="account-form-grid" style="margin-top:16px">',
      '<div class="account-field"><label for="preferenceTheme">Theme</label><select id="preferenceTheme"><option value="system"' + selected(preferences.theme, "system") + '>System</option><option value="dark"' + selected(preferences.theme, "dark") + '>Dark</option><option value="light"' + selected(preferences.theme, "light") + '>Light</option></select></div>',
      '<div class="account-field"><label for="preferenceAccent">Accent</label><select id="preferenceAccent"><option value="indigo"' + selected(preferences.accent, "indigo") + '>Indigo</option><option value="emerald"' + selected(preferences.accent, "emerald") + '>Emerald</option><option value="blue"' + selected(preferences.accent, "blue") + '>Blue</option><option value="cyan"' + selected(preferences.accent, "cyan") + '>Cyan</option><option value="rose"' + selected(preferences.accent, "rose") + '>Rose</option><option value="amber"' + selected(preferences.accent, "amber") + '>Amber</option><option value="zinc"' + selected(preferences.accent, "zinc") + '>Zinc</option></select></div>',
      '<div class="account-field"><label for="preferenceLanguage">Language</label><input id="preferenceLanguage" value="' + esc(preferences.language || "en-US") + '" maxlength="20" /></div>',
      '<div class="account-field"><label for="preferenceTimezone">Timezone</label><input id="preferenceTimezone" value="' + esc(preferences.timezone || "UTC") + '" maxlength="100" placeholder="America/Los_Angeles" /></div>',
      '<div class="account-field"><label for="preferenceDateFormat">Date format</label><select id="preferenceDateFormat"><option value="MM/DD/YYYY"' + selected(preferences.dateFormat, "MM/DD/YYYY") + '>MM/DD/YYYY</option><option value="DD/MM/YYYY"' + selected(preferences.dateFormat, "DD/MM/YYYY") + '>DD/MM/YYYY</option><option value="YYYY-MM-DD"' + selected(preferences.dateFormat, "YYYY-MM-DD") + '>YYYY-MM-DD</option></select></div>',
      '<div class="account-field"><label for="preferenceTimeFormat">Time format</label><select id="preferenceTimeFormat"><option value="12h"' + selected(preferences.timeFormat, "12h") + '>12 hour</option><option value="24h"' + selected(preferences.timeFormat, "24h") + '>24 hour</option></select></div>',
      '</div><div class="account-switch-grid" style="margin-top:16px"><label class="account-switch"><input id="preferenceReducedMotion" type="checkbox"' + checked(preferences.reducedMotion) + ' /><span><strong>Reduced motion</strong><div class="account-muted">Limit interface animation.</div></span></label><label class="account-switch"><input id="preferenceCompactMode" type="checkbox"' + checked(preferences.compactMode) + ' /><span><strong>Compact mode</strong><div class="account-muted">Show denser tables and cards.</div></span></label></div></section>',
      '<section class="account-card"><h3>Notifications</h3><div class="account-switch-grid" style="margin-top:16px">',
      '<label class="account-switch"><input id="preferenceEmailNotifications" type="checkbox"' + checked(preferences.emailNotifications) + ' /><span><strong>Email notifications</strong><div class="account-muted">Account and workflow updates.</div></span></label>',
      '<label class="account-switch"><input id="preferencePushNotifications" type="checkbox"' + checked(preferences.pushNotifications) + ' /><span><strong>Push notifications</strong><div class="account-muted">Browser and supported-device alerts.</div></span></label>',
      '<label class="account-switch"><input id="preferenceSecurityNotifications" type="checkbox"' + checked(preferences.securityNotifications) + ' /><span><strong>Security alerts</strong><div class="account-muted">Sign-in and account protection events.</div></span></label>',
      '<label class="account-switch"><input id="preferenceBillingNotifications" type="checkbox"' + checked(preferences.billingNotifications) + ' /><span><strong>Billing alerts</strong><div class="account-muted">Invoices, plans, and usage limits.</div></span></label>',
      '<label class="account-switch"><input id="preferenceSystemNotifications" type="checkbox"' + checked(preferences.systemNotifications) + ' /><span><strong>System alerts</strong><div class="account-muted">Maintenance and platform health.</div></span></label>',
      '<div class="account-field"><label for="preferenceDigest">Digest frequency</label><select id="preferenceDigest"><option value="instant"' + selected(preferences.digestFrequency, "instant") + '>Instant</option><option value="daily"' + selected(preferences.digestFrequency, "daily") + '>Daily</option><option value="weekly"' + selected(preferences.digestFrequency, "weekly") + '>Weekly</option><option value="off"' + selected(preferences.digestFrequency, "off") + '>Off</option></select></div>',
      '</div><div class="account-actions" style="margin-top:18px"><button class="account-action primary" type="button" onclick="window.saveAccountPreferences()">Save Preferences</button><button class="account-action" type="button" onclick="window.resetAccountPreferences()">Reset Defaults</button></div></section>',
      '<div class="account-layout"><section class="account-card"><h3>Change Password</h3><div class="account-form-grid" style="grid-template-columns:1fr;margin-top:16px"><div class="account-field"><label for="currentPassword">Current password</label><input id="currentPassword" type="password" autocomplete="current-password" /></div><div class="account-field"><label for="newPassword">New password</label><input id="newPassword" type="password" minlength="12" autocomplete="new-password" /></div><div class="account-field"><label for="confirmPassword">Confirm new password</label><input id="confirmPassword" type="password" minlength="12" autocomplete="new-password" /></div></div><button class="account-action primary" style="margin-top:16px" type="button" onclick="window.changeAccountPassword()">Update Password</button></section>',
      '<section class="account-card"><h3>Account Data</h3><p class="account-muted">Create a JSON export containing your profile, preferences, applications, teams, sessions, and recent account activity.</p><button class="account-action" type="button" onclick="window.exportAccountSettings()">Download My Data</button></section></div>',
      '</div>'
    ].join("");
  };

  window.saveUserProfile = async function saveUserProfile() {
    try {
      var payload = await request("/api/settings/profile", { method: "PATCH", body: JSON.stringify({ firstName: document.getElementById("profileFirstName").value, lastName: document.getElementById("profileLastName").value, displayName: document.getElementById("profileDisplayName").value, phone: document.getElementById("profilePhone").value }) });
      state.accountOverview.profile = payload.profile;
      state.user = Object.assign({}, state.user || {}, payload.profile || {});
      window.goodosUpdateUserPill();
      renderAccount();
      showStatus(payload.message || "Profile saved.", false);
    } catch (error) { showStatus(error.message || "Profile could not be saved.", true); }
  };

  window.uploadUserAvatar = async function uploadUserAvatar(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    try {
      var payload = await upload("/api/settings/avatar", "avatar", file);
      state.accountOverview.profile = payload.profile;
      state.user = Object.assign({}, state.user || {}, payload.profile || {});
      window.goodosUpdateUserPill();
      renderAccount();
      showStatus(payload.message || "Profile photo saved.", false);
    } catch (error) { showStatus(error.message || "Profile photo upload failed.", true); }
  };

  window.removeUserAvatar = async function removeUserAvatar() {
    if (!window.confirm("Remove your current profile photo?")) return;
    try {
      var payload = await request("/api/settings/avatar", { method: "DELETE" });
      state.accountOverview.profile = payload.profile;
      state.user = Object.assign({}, state.user || {}, payload.profile || {});
      window.goodosUpdateUserPill();
      renderAccount();
      showStatus(payload.message || "Profile photo removed.", false);
    } catch (error) { showStatus(error.message || "Profile photo could not be removed.", true); }
  };

  window.saveBusinessProfile = async function saveBusinessProfile() {
    try {
      var body = {
        name: document.getElementById("businessName").value,
        legalName: document.getElementById("businessLegalName").value,
        businessEmail: document.getElementById("businessEmail").value,
        supportEmail: document.getElementById("businessSupportEmail").value,
        phone: document.getElementById("businessPhone").value,
        websiteUrl: document.getElementById("businessWebsite").value,
        industry: document.getElementById("businessIndustry").value,
        companySize: document.getElementById("businessSize").value,
        description: document.getElementById("businessDescription").value,
        addressLine1: document.getElementById("businessAddress1").value,
        addressLine2: document.getElementById("businessAddress2").value,
        city: document.getElementById("businessCity").value,
        region: document.getElementById("businessRegion").value,
        postalCode: document.getElementById("businessPostal").value,
        countryCode: document.getElementById("businessCountry").value
      };
      var payload = await request("/api/settings/business-profile", { method: "PATCH", body: JSON.stringify(body) });
      state.accountOverview.organization = payload.organization;
      state.accountOverview.workspace = payload.workspace;
      renderAccount();
      showStatus(payload.message || "Business profile saved.", false);
    } catch (error) { showStatus(error.message || "Business profile could not be saved.", true); }
  };

  window.uploadBusinessLogo = async function uploadBusinessLogo(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    try {
      var payload = await upload("/api/settings/business-logo", "logo", file);
      state.accountOverview.organization = payload.organization;
      state.accountOverview.workspace = payload.workspace;
      renderAccount();
      showStatus(payload.message || "Business logo saved.", false);
    } catch (error) { showStatus(error.message || "Business logo upload failed.", true); }
  };

  window.removeBusinessLogo = async function removeBusinessLogo() {
    if (!window.confirm("Remove the current business logo?")) return;
    try {
      var payload = await request("/api/settings/business-logo", { method: "DELETE" });
      state.accountOverview.organization = payload.organization;
      state.accountOverview.workspace = payload.workspace;
      renderAccount();
      showStatus(payload.message || "Business logo removed.", false);
    } catch (error) { showStatus(error.message || "Business logo could not be removed.", true); }
  };

  window.saveAccountPreferences = async function saveAccountPreferences() {
    try {
      var body = {
        theme: document.getElementById("preferenceTheme").value,
        accent: document.getElementById("preferenceAccent").value,
        language: document.getElementById("preferenceLanguage").value,
        timezone: document.getElementById("preferenceTimezone").value,
        dateFormat: document.getElementById("preferenceDateFormat").value,
        timeFormat: document.getElementById("preferenceTimeFormat").value,
        reducedMotion: document.getElementById("preferenceReducedMotion").checked,
        compactMode: document.getElementById("preferenceCompactMode").checked,
        emailNotifications: document.getElementById("preferenceEmailNotifications").checked,
        pushNotifications: document.getElementById("preferencePushNotifications").checked,
        securityNotifications: document.getElementById("preferenceSecurityNotifications").checked,
        billingNotifications: document.getElementById("preferenceBillingNotifications").checked,
        systemNotifications: document.getElementById("preferenceSystemNotifications").checked,
        digestFrequency: document.getElementById("preferenceDigest").value
      };
      var payload = await request("/api/settings/preferences", { method: "PATCH", body: JSON.stringify(body) });
      state.accountOverview.preferences = payload.preferences;
      renderAccount();
      showStatus(payload.message || "Preferences saved.", false);
    } catch (error) { showStatus(error.message || "Preferences could not be saved.", true); }
  };

  window.resetAccountPreferences = async function resetAccountPreferences() {
    if (!window.confirm("Reset your preferences to the GoodOS defaults?")) return;
    try {
      var payload = await request("/api/settings/preferences", { method: "DELETE" });
      state.accountOverview.preferences = payload.preferences;
      renderAccount();
      showStatus(payload.message || "Preferences reset.", false);
    } catch (error) { showStatus(error.message || "Preferences could not be reset.", true); }
  };

  window.changeAccountPassword = async function changeAccountPassword() {
    var currentPassword = document.getElementById("currentPassword").value;
    var newPassword = document.getElementById("newPassword").value;
    var confirmation = document.getElementById("confirmPassword").value;
    if (newPassword.length < 12) return showStatus("New passwords must contain at least 12 characters.", true);
    if (newPassword !== confirmation) return showStatus("New password confirmation does not match.", true);
    try {
      var payload = await request("/api/settings/password", { method: "POST", body: JSON.stringify({ currentPassword: currentPassword, newPassword: newPassword }) });
      document.getElementById("currentPassword").value = "";
      document.getElementById("newPassword").value = "";
      document.getElementById("confirmPassword").value = "";
      showStatus(payload.message || "Password updated.", false);
    } catch (error) { showStatus(error.message || "Password could not be updated.", true); }
  };

  window.revokeAccountSession = async function revokeAccountSession(sessionId) {
    if (!window.confirm("Revoke this session?")) return;
    try {
      await request("/api/settings/sessions/" + encodeURIComponent(sessionId), { method: "DELETE" });
      await window.loadAccountSettings(true);
      showStatus("Session revoked.", false);
    } catch (error) { showStatus(error.message || "Session could not be revoked.", true); }
  };

  window.exportAccountSettings = async function exportAccountSettings() {
    try {
      var payload = await request("/api/settings/export", { method: "POST" });
      var blob = new Blob([JSON.stringify(payload.data || {}, null, 2)], { type: "application/json" });
      var url = URL.createObjectURL(blob);
      var link = document.createElement("a");
      link.href = url;
      link.download = payload.fileName || "goodos-settings.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showStatus("Account data export downloaded.", false);
    } catch (error) { showStatus(error.message || "Account data could not be exported.", true); }
  };

  window.goodosUpdateUserPill();
})();
