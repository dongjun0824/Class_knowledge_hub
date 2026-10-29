const state = {
  token: localStorage.getItem("token") || "",
  user: null,
  subjects: [],
  posts: [],
  selectedSubjectId: "",
  selectedUnitId: ""
};

const elements = {
  loginForm: document.getElementById("loginForm"),
  registerForm: document.getElementById("registerForm"),
  postForm: document.getElementById("postForm"),
  filterForm: document.getElementById("filterForm"),
  postsContainer: document.getElementById("postsContainer"),
  userSummary: document.getElementById("userSummary"),
  myInfo: document.getElementById("myInfo"),
  btnLogout: document.getElementById("btnLogout"),
  btnAdmin: document.getElementById("btnAdmin"),
  adminPanel: document.querySelector(".admin-panel"),
  subjectSelect: document.getElementById("subjectSelect"),
  unitSelect: document.getElementById("unitSelect"),
  filterSubjectSelect: document.getElementById("filterSubjectSelect"),
  filterUnitSelect: document.getElementById("filterUnitSelect"),
  adminSubjectSelect: document.getElementById("adminSubjectSelect"),
  adminUsersList: document.getElementById("adminUsersList"),
  adminReportsList: document.getElementById("adminReportsList"),
  subjectAdminForm: document.getElementById("subjectAdminForm"),
  unitAdminForm: document.getElementById("unitAdminForm"),
  policyForm: document.getElementById("policyForm")
};

function apiFetch(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  return fetch(url, {
    ...options,
    headers,
    credentials: "same-origin"
  }).then(async res => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || "요청 처리에 실패했습니다.");
    }
    return data;
  });
}

function showMessage(msg, isError = false) {
  alert(msg);
  if (isError) console.error(msg);
}

function setUser(user) {
  state.user = user;
  const isLoggedIn = !!user;

  elements.userSummary.classList.toggle("hidden", !isLoggedIn);
  elements.btnLogout.classList.toggle("hidden", !isLoggedIn);
  elements.btnAdmin.classList.toggle("hidden", !(isLoggedIn && user.role === "admin"));
  elements.adminPanel.classList.toggle("hidden", !(isLoggedIn && user.role === "admin"));

  if (user) {
    elements.userSummary.innerHTML = `
      <div><strong>${user.nickname}</strong></div>
      <div>Lv.${user.level} / ${user.points}점</div>
    `;
    elements.myInfo.innerHTML = `
      <p><strong>닉네임:</strong> ${user.nickname}</p>
      <p><strong>역할:</strong> ${user.role}</p>
      <p><strong>포인트:</strong> ${user.points}점</p>
      <p><strong>레벨:</strong> Lv.${user.level}</p>
    `;
  } else {
    elements.userSummary.innerHTML = "";
    elements.myInfo.innerHTML = "로그인 후 확인 가능합니다.";
  }
}

async function loadUser() {
  if (!state.token) {
    setUser(null);
    return;
  }

  try {
    const data = await apiFetch("/api/auth/me");
    setUser(data.user);
    await loadBoard();
    await loadAdminData();
    await loadPolicies();
  } catch (err) {
    localStorage.removeItem("token");
    state.token = "";
    setUser(null);
    showMessage(err.message, true);
  }
}

async function loadSubjects() {
  try {
    const result = await apiFetch("/api/subjects");
    state.subjects = result.subjects || [];

    const subjectOptions = ["<option value=''>선택</option>"];
    const filterOptions = ["<option value=''>전체 교과</option>"];
    const adminOptions = ["<option value=''>선택</option>"];

    for (const subject of state.subjects) {
      subjectOptions.push(`<option value="${subject.id}">${subject.name}</option>`);
      filterOptions.push(`<option value="${subject.id}">${subject.name}</option>`);
      adminOptions.push(`<option value="${subject.id}">${subject.name}</option>`);
    }

    elements.subjectSelect.innerHTML = subjectOptions.join("");
    elements.filterSubjectSelect.innerHTML = filterOptions.join("");
    elements.adminSubjectSelect.innerHTML = adminOptions.join("");

    if (state.subjects.length) {
      elements.subjectSelect.value = state.subjects[0].id;
      state.selectedSubjectId = state.subjects[0].id;
    }
  } catch (err) {
    showMessage(err.message, true);
  }
}

function renderUnitOptions(subjectId, targetSelect, includeEmpty = true) {
  const subject = state.subjects.find(s => String(s.id) === String(subjectId));
  const unitOptions = [];
  if (includeEmpty) unitOptions.push("<option value=''>선택</option>");
  if (subject && subject.units) {
    for (const unit of subject.units) {
      unitOptions.push(`<option value="${unit.id}">${unit.name}</option>`);
    }
  }
  targetSelect.innerHTML = unitOptions.join("");
}

async function loadBoard() {
  try {
    const params = new URLSearchParams();
    if (elements.filterSubjectSelect.value) params.set("subject_id", elements.filterSubjectSelect.value);
    if (elements.filterUnitSelect.value) params.set("unit_id", elements.filterUnitSelect.value);
    if (document.querySelector("#filterForm [name='type']").value) params.set("type", document.querySelector("#filterForm [name='type']").value);
    if (document.querySelector("#filterForm [name='difficulty']").value) params.set("difficulty", document.querySelector("#filterForm [name='difficulty']").value);
    if (document.querySelector("#filterForm [name='q']").value) params.set("q", document.querySelector("#filterForm [name='q']").value);
    if (document.querySelector("#filterForm [name='sort']").value) params.set("sort", document.querySelector("#filterForm [name='sort']").value);

    const url = `/api/board${params.toString() ? `?${params.toString()}` : ""}`;
    const result = await apiFetch(url);
    state.posts = result.posts || [];

    renderPosts();
  } catch (err) {
    showMessage(err.message, true);
  }
}

function renderPosts() {
  if (!state.posts.length) {
    elements.postsContainer.innerHTML = `<div class='notice'>표시할 게시글이 없습니다.</div>`;
    return;
  }

  elements.postsContainer.innerHTML = state.posts.map(post => {
    const typeClass = post.type || "concept";
    const answerHtml = (post.type === "question" && post.answer) ? `
      <div class="answer-box ${post.can_view ? "visible" : ""}">
        <div class="answer-label">정답</div>
        <div>${post.answer || "정답 없음"}</div>
      </div>
    ` : "";
    const explanationHtml = post.explanation ? `
      <div class="explain-box ${post.can_view ? "visible" : ""}">
        <div class="explain-label">해설</div>
        <div>${post.explanation}</div>
      </div>
    ` : "";
    const lockedBlock = !post.can_view ? "<div class='notice'>이 자료는 Lv." + post.required_level + " 이상에서만 열람할 수 있습니다.</div>" : "";

    return `
      <article class="post-card" data-post-id="${post.id}">
        <div class="post-top">
          <span class="post-type ${typeClass}">${post.type === "concept" ? "개념 정리" : post.type === "question" ? "문제" : post.type === "note" ? "비법 노트" : "오답 정리"}</span>
          <span>${post.subject_name} / ${post.unit_name || "-"}</span>
        </div>

        <div class="post-title">${post.title}</div>

        <div class="meta-row">
          <span>작성자: ${post.author}</span>
          <span>난이도: ${post.difficulty || "중"}</span>
          <span>필수레벨: Lv.${post.required_level}</span>
          <span>좋아요 ${post.likes_count}</span>
          <span>댓글 ${post.comments_count}</span>
        </div>

        <div class="post-body">${lockedBlock || post.content}</div>

        ${answerHtml}
        ${explanationHtml}

        <div class="post-actions">
          <button class="inline-btn like-btn" data-post-id="${post.id}">좋아요 (${post.likes_count})</button>
          ${post.type === "question" ? `<button class="inline-btn toggle-answer-btn" data-post-id="${post.id}">정답 확인</button>` : ""}
          <button class="inline-btn report-btn" data-post-id="${post.id}">신고</button>
        </div>

        <div class="comment-box">
          <div class="comment-list">
            ${renderCommentList(post.id)}
          </div>
          <form class="comment-form" data-post-id="${post.id}">
            <input name="comment" type="text" placeholder="댓글을 입력하세요" maxlength="500" />
            <button class="inline-btn" type="submit">댓글 달기</button>
          </form>
        </div>
      </article>
    `;
  }).join("");

  document.querySelectorAll(".toggle-answer-btn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const postId = Number(btn.dataset.postId);
      const article = document.querySelector(`.post-card[data-post-id="${postId}"]`);
      const answerBox = article.querySelector(".answer-box");
      const explainBox = article.querySelector(".explain-box");
      if (!answerBox || !explainBox) return;
      answerBox.classList.toggle("visible");
      explainBox.classList.toggle("visible");
    });
  });

  document.querySelectorAll(".like-btn").forEach(btn => {
    btn.addEventListener("click", handleLike);
  });

  document.querySelectorAll(".report-btn").forEach(btn => {
    btn.addEventListener("click", handleReport);
  });

  document.querySelectorAll(".comment-form").forEach(form => {
    form.addEventListener("submit", handleCommentSubmit);
  });
}

function renderCommentList(postId) {
  const post = state.posts.find(p => Number(p.id) === Number(postId));
  if (!post || !post.comments) return "<div class='notice'>댓글이 아직 없습니다.</div>";
  if (!post.comments.length) return "<div class='notice'>댓글이 아직 없습니다.</div>";
  return post.comments.map(comment => `
    <div class="comment-item"><strong>${comment.author_name}</strong> : ${comment.content}</div>
  `).join("");
}

async function handleLike(event) {
  const postId = Number(event.currentTarget.dataset.postId);
  if (!state.user) {
    showMessage("로그인 후 좋아요를 사용할 수 있습니다.");
    return;
  }

  try {
    const result = await apiFetch(`/api/board/${postId}/like`, { method: "POST" });
    await loadBoard();
    showMessage(result.message || "좋아요 반영 완료");
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function handleCommentSubmit(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const postId = Number(form.dataset.postId);
  const value = form.querySelector("input[name='comment']").value.trim();

  if (!state.user) {
    showMessage("로그인 후 댓글을 작성할 수 있습니다.");
    return;
  }

  try {
    const result = await apiFetch(`/api/board/${postId}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: value })
    });

    const post = state.posts.find(p => Number(p.id) === Number(postId));
    if (post) {
      post.comments = result.comments || [];
    }

    form.reset();
    await loadBoard();
    showMessage(result.message || "댓글이 작성되었습니다.");
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function handleReport(event) {
  const postId = Number(event.currentTarget.dataset.postId);
  const reason = prompt("신고 사유를 입력하세요.");
  if (!reason) return;

  try {
    const result = await apiFetch(`/api/board/${postId}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason })
    });
    showMessage(result.message || "신고 완료");
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function loadPolicies() {
  if (!state.user || state.user.role !== "admin") return;

  try {
    const result = await apiFetch("/api/admin/policies");
    const form = elements.policyForm;
    for (const key of Object.keys(result.policies || {})) {
      const field = form.querySelector(`[name="${key}"]`);
      if (field) field.value = result.policies[key];
    }
  } catch (err) {
    showMessage(err.message, true);
  }
}

async function loadAdminData() {
  if (!state.user || state.user.role !== "admin") return;

  try {
    const [usersResult, reportsResult, policiesResult] = await Promise.all([
      apiFetch("/api/admin/users"),
      apiFetch("/api/admin/reports"),
      apiFetch("/api/admin/policies")
    ]);

    const users = usersResult.users || [];
    elements.adminUsersList.innerHTML = users.map(user => `
      <div class="notice">
        <strong>${user.nickname}</strong> / ${user.role} / ${user.points}점 / Lv.${user.level}
      </div>
    `).join("") || "<div class='notice'>사용자가 없습니다.</div>";

    elements.adminReportsList.innerHTML = (reportsResult.reports || []).map(report => `
      <div class="notice">
        <strong>${report.reporter_nickname || "알 수 없음"}</strong> 신고:
        ${report.post_title || "게시글"} / ${report.reason}
      </div>
    `).join("") || "<div class='notice'>신고 내역이 없습니다.</div>";

    const form = elements.policyForm;
    for (const key of Object.keys(policiesResult.policies || {})) {
      const field = form.querySelector(`[name="${key}"]`);
      if (field) field.value = policiesResult.policies[key];
    }
  } catch (err) {
    showMessage(err.message, true);
  }
}

elements.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const nickname = formData.get("nickname").toString().trim();
  const password = formData.get("password").toString();

  try {
    const result = await apiFetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, password })
    });

    state.token = result.token;
    localStorage.setItem("token", result.token);
    setUser(result.user);
    event.currentTarget.reset();
    await loadUser();
    await loadBoard();
  } catch (err) {
    showMessage(err.message, true);
  }
});

elements.registerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const nickname = formData.get("nickname").toString().trim();
  const password = formData.get("password").toString();

  try {
    const result = await apiFetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname, password })
    });

    state.token = result.token;
    localStorage.setItem("token", result.token);
    setUser(result.user);
    event.currentTarget.reset();
    await loadUser();
    await loadBoard();
  } catch (err) {
    showMessage(err.message, true);
  }
});

elements.btnLogout.addEventListener("click", () => {
  localStorage.removeItem("token");
  state.token = "";
  state.user = null;
  setUser(null);
  showMessage("로그아웃 되었습니다.");
});

elements.postForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  if (!state.user) {
    showMessage("로그인 후 게시물을 작성할 수 있습니다.");
    return;
  }

  const formData = new FormData(event.currentTarget);
  const payload = {
    title: formData.get("title"),
    subject_id: Number(formData.get("subject_id")),
    unit_id: Number(formData.get("unit_id") || 0),
    type: formData.get("type"),
    difficulty: formData.get("difficulty"),
    required_level: Number(formData.get("required_level") || 1),
    content: formData.get("content"),
    answer: formData.get("answer"),
    explanation: formData.get("explanation")
  };

  try {
    const result = await apiFetch("/api/board", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    event.currentTarget.reset();
    await loadBoard();
    showMessage(result.message || "게시글 등록 완료");
  } catch (err) {
    showMessage(err.message, true);
  }
});

elements.filterForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  await loadBoard();
});

elements.filterSubjectSelect.addEventListener("change", () => {
  const subjectId = elements.filterSubjectSelect.value;
  renderUnitOptions(subjectId, elements.filterUnitSelect, true);
});

elements.subjectSelect.addEventListener("change", () => {
  const subjectId = elements.subjectSelect.value;
  renderUnitOptions(subjectId, elements.unitSelect, true);
});

elements.subjectAdminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const payload = {
    name: formData.get("name"),
    description: formData.get("description")
  };

  try {
    const result = await apiFetch("/api/admin/subjects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    event.currentTarget.reset();
    await loadSubjects();
    await loadAdminData();
    showMessage(result.message || "교과목이 추가되었습니다.");
  } catch (err) {
    showMessage(err.message, true);
  }
});

elements.unitAdminForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const payload = {
    subject_id: Number(formData.get("subject_id")),
    name: formData.get("name")
  };

  try {
    const result = await apiFetch("/api/admin/units", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    event.currentTarget.reset();
    await loadSubjects();
    await loadBoard();
    showMessage(result.message || "단원이 추가되었습니다.");
  } catch (err) {
    showMessage(err.message, true);
  }
});

elements.policyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(event.currentTarget);
  const payload = {};
  for (const [key, value] of formData.entries()) {
    if (value !== "") payload[key] = value;
  }

  try {
    const result = await apiFetch("/api/admin/policies", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    showMessage(result.message || "정책 저장 완료");
  } catch (err) {
    showMessage(err.message, true);
  }
});

async function init() {
  await loadSubjects();
  renderUnitOptions(elements.subjectSelect.value, elements.unitSelect, true);
  renderUnitOptions(elements.filterSubjectSelect.value, elements.filterUnitSelect, true);

  if (state.token) {
    await loadUser();
  } else {
    setUser(null);
    await loadBoard();
  }
}

init();
