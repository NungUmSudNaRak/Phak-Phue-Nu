import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONTRACT_ABI } from "./abi.js";
import { CONFIG } from "./config.js";

// Enum order must match CampaignStatus and MilestoneStatus in the contract.
const CAMPAIGN_STATUS = ["Funding", "Failed", "Active", "Completed"];
const MILESTONE_STATUS = ["Pending", "Voting", "Rejected", "Released"];

const CAMPAIGN_STATUS_TH = {
  Funding: "กำลังระดมทุน",
  Failed: "ไม่สำเร็จ",
  Active: "กำลังดำเนินงาน",
  Completed: "สำเร็จ",
};
const MILESTONE_STATUS_TH = {
  Pending: "รอส่งงาน",
  Voting: "กำลังโหวต",
  Rejected: "ไม่ผ่าน",
  Released: "จ่ายแล้ว",
};

// Thai messages for the contract's custom errors.
const ERROR_TH = {
  CampaignNotFound: "ไม่พบโครงการนี้",
  NotCampaignOwner: "ทำได้เฉพาะเจ้าของโครงการ",
  EmptyValue: "กรอกข้อมูลให้ครบ",
  ZeroValue: "จำนวนต้องมากกว่า 0",
  InvalidMilestoneCount: "ต้องมี Milestone 1 ถึง 10 รายการ",
  MilestoneTotalMismatch: "งบของ Milestone รวมกันต้องเท่ากับเป้าหมาย",
  InvalidMilestoneIndex: "ไม่มี Milestone นี้",
  OwnerCannotContribute: "เจ้าของโครงการสนับสนุนโครงการตัวเองไม่ได้",
  VoteInProgress: "มีการโหวตที่ยังไม่ปิดอยู่",
  NoVoteInProgress: "ตอนนี้ไม่มีการโหวต",
  VotingClosed: "หมดเวลาโหวตแล้ว",
  VotingStillOpen: "ยังปิดโหวตไม่ได้ ผลยังไม่ชัดและยังไม่หมดเวลา",
  NotBacker: "โหวตได้เฉพาะผู้สนับสนุนโครงการนี้",
  AlreadyVoted: "คุณโหวตรอบนี้ไปแล้ว",
  ExceedsAllocatedFunds: "ยอดจ่ายเกินเงินที่จัดสรรไว้",
  AlreadyRefunded: "คุณรับเงินคืนไปแล้ว",
  NothingToRefund: "ไม่มียอดให้คืน",
  TransferFailed: "โอน ETH ไม่สำเร็จ",
  ReentrantCall: "ถูกบล็อกโดยตัวป้องกัน reentrancy",
};

const NETWORKS = {
  1: { name: "Ethereum Mainnet", explorer: "https://etherscan.io" },
  11155111: { name: "Sepolia", explorer: "https://sepolia.etherscan.io" },
  31337: { name: "Hardhat Local" },
  1337: { name: "Localhost" },
};

const HISTORY_EVENTS = [
  "Contributed",
  "MilestoneReleaseRequested",
  "MilestoneVoted",
  "MilestoneRejected",
  "MilestoneReleased",
  "Refunded",
];

const STORAGE_KEY = "innovatefund.contract";
const REFRESH_MS = 15000;

const $ = (selector, root = document) => root.querySelector(selector);

const state = {
  provider: null,
  signer: null,
  account: null,
  chainId: null,
  contract: null,
  fromBlock: 0,
  approvalPercent: 50n,
  campaigns: [],
  selectedId: null,
  busy: false,
  chainNow: 0, // chain time in seconds at the last refresh
  fetchedAt: 0, // Date.now() at the last refresh
  blockTimes: new Map(),
};

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Escapes text before it goes into innerHTML. On-chain strings are user input. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[ch]);
}

/** Only http(s) and ipfs links become clickable, so a `javascript:` URL cannot run. */
function safeUrl(value) {
  const text = String(value ?? "").trim();
  if (/^https?:\/\//i.test(text)) return text;
  if (/^ipfs:\/\//i.test(text)) return `https://ipfs.io/ipfs/${text.slice(7)}`;
  return null;
}

function evidenceHtml(value) {
  if (!value) return '<span class="muted">-</span>';
  const url = safeUrl(value);
  const label = esc(value.length > 40 ? `${value.slice(0, 37)}...` : value);
  return url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : label;
}

function formatEth(wei) {
  const value = Number(ethers.formatEther(wei));
  return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
}

function percent(part, total) {
  if (total === 0n) return 0;
  return Number((part * 10000n) / total) / 100;
}

function shortAddress(address) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "";
}

function sameAddress(a, b) {
  return Boolean(a && b) && a.toLowerCase() === b.toLowerCase();
}

function addressHtml(address) {
  const you = sameAddress(address, state.account) ? ' <span class="you">คุณ</span>' : "";
  return `<span class="mono" title="${esc(address)}">${esc(shortAddress(address))}</span>${you}`;
}

function formatDate(unixSeconds) {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("th-TH", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/** Compact date for table cells; the full date is in the cell's tooltip. */
function dateCell(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  const short = date.toLocaleString("th-TH", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `<td class="date" title="${formatDate(unixSeconds)}">${short}</td>`;
}

function formatDuration(seconds) {
  if (seconds <= 0) return "หมดเวลาแล้ว";
  const s = Math.floor(seconds);
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return days > 0 ? `${days} วัน ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}

/** Best estimate of the chain's current time, ticking between refreshes. */
function chainNow() {
  return state.chainNow + (Date.now() - state.fetchedAt) / 1000;
}

function explorerUrl(kind, value) {
  const base = NETWORKS[state.chainId]?.explorer;
  return base ? `${base}/${kind}/${value}` : null;
}

function txHtml(hash) {
  const url = explorerUrl("tx", hash);
  const label = `${hash.slice(0, 10)}…`;
  return url
    ? `<a class="mono" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`
    : `<span class="mono" title="${hash}">${label}</span>`;
}

function statusBadge(status, labels) {
  return `<span class="badge s-${status.toLowerCase()}">${labels[status]}</span>`;
}

function card(title, body, extraClass = "") {
  return `<section class="card ${extraClass}"><h2>${title}</h2>${body}</section>`;
}

// ---------------------------------------------------------------------------
// Errors, toasts and notices
// ---------------------------------------------------------------------------

function decodeRevert(err) {
  if (err?.revert?.name) return err.revert;
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (!data || !state.contract) return null;
  try {
    return state.contract.interface.parseError(data);
  } catch {
    return null;
  }
}

function errorMessage(err) {
  if (err?.code === "ACTION_REJECTED") return "ยกเลิกรายการใน Wallet แล้ว";
  if (err?.code === "INSUFFICIENT_FUNDS") return "ETH ใน Wallet ไม่พอสำหรับยอดที่โอนและค่าแก๊ส";

  const revert = decodeRevert(err);
  if (revert) {
    const args = revert.args ?? [];
    if (revert.name === "WrongStatus") {
      const expected = CAMPAIGN_STATUS_TH[CAMPAIGN_STATUS[Number(args[0])]];
      const actual = CAMPAIGN_STATUS_TH[CAMPAIGN_STATUS[Number(args[1])]];
      return `ทำไม่ได้ในสถานะนี้ ต้องเป็น "${expected}" แต่ตอนนี้เป็น "${actual}"`;
    }
    if (revert.name === "ExceedsGoal") {
      return `เกินเป้าหมาย รับได้อีกไม่เกิน ${formatEth(args[0])} ETH`;
    }
    return `${ERROR_TH[revert.name] ?? "ธุรกรรมถูกปฏิเสธ"} (${revert.name})`;
  }
  return err?.shortMessage ?? err?.message ?? String(err);
}

const TOAST_LIFETIME_MS = { success: 8000, error: 20000 }; // pending stays until updated

/** Shows a message in the corner. `html` must already be escaped. Click to dismiss. */
function showToast(html, kind) {
  const el = document.createElement("div");
  el.addEventListener("click", () => el.remove());
  $("#toasts").prepend(el);
  const update = (nextHtml, nextKind) => {
    el.className = `toast ${nextKind}`;
    el.innerHTML = nextHtml;
    const lifetime = TOAST_LIFETIME_MS[nextKind];
    if (lifetime) setTimeout(() => el.remove(), lifetime);
  };
  update(html, kind);
  return { update };
}

function showNotice(text, kind = "info") {
  const el = $("#notice");
  el.className = `notice ${kind}`;
  el.textContent = text;
  el.hidden = false;
}

function hideNotice() {
  $("#notice").hidden = true;
}

/** Locks buttons while a transaction runs. Buttons marked `data-blocked` stay
 *  disabled afterwards because the contract would reject them anyway. */
function setBusy(busy) {
  state.busy = busy;
  document.querySelectorAll("[data-busy-lock]").forEach((el) => {
    el.disabled = busy || el.hasAttribute("data-blocked");
  });
}

// ---------------------------------------------------------------------------
// Wallet and contract
// ---------------------------------------------------------------------------

async function setAccount(address) {
  state.account = address ? ethers.getAddress(address) : null;
  state.signer = address ? await state.provider.getSigner(address) : null;
  renderWallet();
}

async function connect() {
  try {
    const accounts = await state.provider.send("eth_requestAccounts", []);
    await setAccount(accounts[0]);
    await refresh();
  } catch (err) {
    showToast(esc(errorMessage(err)), "error");
  }
}

async function ensureSigner() {
  if (!state.signer) await connect();
  return state.signer;
}

function renderWallet() {
  const network = $("#network");
  const account = $("#account");
  const button = $("#connectBtn");
  network.hidden = state.chainId === null;
  network.textContent = NETWORKS[state.chainId]?.name ?? `Chain ${state.chainId}`;
  account.hidden = !state.account;
  account.textContent = shortAddress(state.account);
  account.title = state.account ?? "";
  button.hidden = Boolean(state.account);
}

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
  } catch {
    return {};
  }
}

function save(address, fromBlock) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ address, fromBlock }));
  } catch {
    // Storage can be blocked; the page still works without it.
  }
}

async function loadContract(address, fromBlock) {
  if (!ethers.isAddress(address)) {
    showNotice("Contract address ไม่ถูกต้อง", "error");
    return;
  }
  const code = await state.provider.getCode(address);
  if (code === "0x") {
    const network = NETWORKS[state.chainId]?.name ?? `Chain ${state.chainId}`;
    showNotice(
      `ไม่พบ contract ที่ ${address} บนเครือข่าย ${network} ตรวจว่าเลือกเครือข่ายใน MetaMask ถูกต้อง`,
      "error"
    );
    return;
  }

  const checksummed = ethers.getAddress(address);
  state.contract = new ethers.Contract(checksummed, CONTRACT_ABI, state.provider);
  state.fromBlock = fromBlock;
  state.blockTimes.clear();
  state.approvalPercent = await state.contract.APPROVAL_PERCENT();
  $("#contractInput").value = checksummed;
  $("#fromBlockInput").value = String(fromBlock);
  save(checksummed, fromBlock);
  hideNotice();
  await refresh();
}

// ---------------------------------------------------------------------------
// Sending transactions
// ---------------------------------------------------------------------------

/** Sends a transaction, reports progress in a toast, then reloads the data. */
async function send(label, method, args, overrides = {}) {
  if (state.busy) return null;
  const signer = await ensureSigner();
  if (!signer) return null;

  setBusy(true);
  const toast = showToast(`${esc(label)}: รอยืนยันใน Wallet…`, "pending");
  try {
    const tx = await state.contract.connect(signer)[method](...args, overrides);
    toast.update(`${esc(label)}: ส่งแล้ว รอบันทึกลงบล็อก ${txHtml(tx.hash)}`, "pending");
    const receipt = await tx.wait();
    // Reload first so the page already shows the new data when "success" appears.
    await refresh().catch(() => {});
    toast.update(`${esc(label)}: สำเร็จ ${txHtml(tx.hash)}`, "success");
    return receipt;
  } catch (err) {
    toast.update(`${esc(label)}: ${esc(errorMessage(err))}`, "error");
    return null;
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------
// Loading data
// ---------------------------------------------------------------------------

async function refresh() {
  if (!state.contract) return;
  // Deadlines are compared with the chain's clock, not the viewer's, which can
  // be wrong (or, on a local test chain, minutes away from block time).
  const [count, now] = await Promise.all([
    state.contract.campaignCount(),
    state.contract.currentTime(),
  ]);
  state.chainNow = Number(now);
  state.fetchedAt = Date.now();

  const ids = Array.from({ length: Number(count) }, (_, i) => i + 1);
  state.campaigns = await Promise.all(
    ids.map(async (id) => {
      const [campaign, status] = await state.contract.getCampaign(id);
      return { id, campaign, status: CAMPAIGN_STATUS[Number(status)] };
    })
  );

  const network = NETWORKS[state.chainId]?.name ?? `Chain ${state.chainId}`;
  const addressUrl = explorerUrl("address", await state.contract.getAddress());
  const addressText = esc(await state.contract.getAddress());
  $("#contractInfo").innerHTML =
    `เครือข่าย ${esc(network)} · ` +
    (addressUrl
      ? `<a class="mono" href="${addressUrl}" target="_blank" rel="noopener noreferrer">${addressText}</a>`
      : `<span class="mono">${addressText}</span>`) +
    ` · ${ids.length} โครงการ`;

  renderCampaignList();
  if (state.selectedId && state.selectedId <= ids.length) {
    await renderDetail(state.selectedId);
  } else {
    renderEmptyDetail();
  }
}

async function blockTime(blockNumber) {
  if (!state.blockTimes.has(blockNumber)) {
    const block = await state.provider.getBlock(blockNumber);
    state.blockTimes.set(blockNumber, block.timestamp);
  }
  return state.blockTimes.get(blockNumber);
}

/** Requirement 7: money in/out and milestone activity, read from events. */
async function loadHistory(campaignId) {
  const contract = state.contract;
  const lists = await Promise.all(
    HISTORY_EVENTS.map((name) =>
      contract.queryFilter(contract.filters[name](campaignId), state.fromBlock, "latest")
    )
  );
  const events = lists
    .flat()
    .sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);
  await Promise.all([...new Set(events.map((e) => e.blockNumber))].map(blockTime));
  return events;
}

// ---------------------------------------------------------------------------
// Rendering: campaign list
// ---------------------------------------------------------------------------

function renderCampaignList() {
  const list = $("#campaignList");
  if (state.campaigns.length === 0) {
    list.innerHTML = '<li class="empty">ยังไม่มีโครงการ สร้างโครงการแรกได้ด้านล่าง</li>';
    return;
  }
  list.innerHTML = [...state.campaigns]
    .reverse()
    .map(({ id, campaign, status }) => {
      const pct = percent(campaign.totalRaised, campaign.goal);
      const selected = id === state.selectedId ? " selected" : "";
      return `
        <li>
          <button type="button" class="campaign-item${selected}" data-select="${id}">
            <span class="item-head">
              <span class="item-title">#${id} ${esc(campaign.title)}</span>
              ${statusBadge(status, CAMPAIGN_STATUS_TH)}
            </span>
            <span class="bar small"><span style="width:${Math.min(pct, 100)}%"></span></span>
            <span class="muted">${formatEth(campaign.totalRaised)} / ${formatEth(campaign.goal)} ETH (${pct}%)</span>
          </button>
        </li>`;
    })
    .join("");
}

function selectCampaign(id) {
  state.selectedId = id;
  history.replaceState(null, "", `${location.pathname}${location.search}#campaign-${id}`);
  renderCampaignList();
  renderDetail(id).catch((err) => showToast(esc(errorMessage(err)), "error"));
}

// ---------------------------------------------------------------------------
// Rendering: campaign detail
// ---------------------------------------------------------------------------

function renderEmptyDetail() {
  $("#detail").innerHTML = card(
    "รายละเอียดโครงการ",
    '<p class="muted">เลือกโครงการจากรายการด้านซ้าย หรือสร้างโครงการใหม่</p>'
  );
}

async function renderDetail(id) {
  const contract = state.contract;
  const [[campaign, statusIndex], milestones, progress] = await Promise.all([
    contract.getCampaign(id),
    contract.getMilestones(id),
    contract.getFundingProgress(id),
  ]);

  const currentIndex = Number(campaign.currentMilestone);
  const ctx = {
    id,
    campaign,
    milestones,
    progress,
    status: CAMPAIGN_STATUS[Number(statusIndex)],
    currentIndex,
    current: milestones[currentIndex] ?? null,
    isOwner: sameAddress(campaign.owner, state.account),
    myContribution: 0n,
    myRefund: 0n,
    refunded: false,
    voted: false,
    history: [],
    historyError: null,
  };

  if (state.account) {
    [ctx.myContribution, ctx.myRefund, ctx.refunded] = await Promise.all([
      contract.contributions(id, state.account),
      contract.getRefundAmount(id, state.account),
      contract.hasRefunded(id, state.account),
    ]);
    if (ctx.current) ctx.voted = await contract.hasVoted(id, currentIndex, state.account);
  }

  try {
    ctx.history = await loadHistory(id);
  } catch (err) {
    ctx.historyError = errorMessage(err);
  }

  // Keep what the user was typing when the panel re-renders.
  const detail = $("#detail");
  const typed = {};
  detail.querySelectorAll("input[id]").forEach((input) => {
    typed[input.id] = input.value;
  });

  detail.innerHTML = [
    overviewCard(ctx),
    actionCard(ctx),
    milestonesCard(ctx),
    moneyCard(ctx),
    historyCard(ctx),
  ].join("");

  Object.entries(typed).forEach(([inputId, value]) => {
    const input = document.getElementById(inputId);
    if (input) input.value = value;
  });
  setBusy(state.busy);
  tickCountdowns();
}

function overviewCard({ id, campaign, progress, status }) {
  const [totalRaised, goal, timeLeft, backerCount] = progress;
  const pct = percent(totalRaised, goal);
  const fundingOpen = status === "Funding" && timeLeft > 0n;
  const fundingClosedLabel = totalRaised >= goal ? "ครบเป้าแล้ว" : "ปิดแล้ว";
  return `
    <section class="card">
      <div class="card-head">
        <div>
          <h2 class="title">#${id} ${esc(campaign.title)}</h2>
          ${campaign.description ? `<p class="desc">${esc(campaign.description)}</p>` : ""}
          <p class="muted">เจ้าของ ${addressHtml(campaign.owner)} · สร้างเมื่อ ${formatDate(campaign.createdAt)}</p>
        </div>
        ${statusBadge(status, CAMPAIGN_STATUS_TH)}
      </div>
      <h3>ความคืบหน้าการระดมทุน <span class="req">ข้อ 3</span></h3>
      <div class="bar"><span style="width:${Math.min(pct, 100)}%"></span></div>
      <div class="stats">
        <div><span class="label">ยอดสะสม</span><strong>${formatEth(totalRaised)} ETH</strong></div>
        <div><span class="label">เป้าหมาย</span><strong>${formatEth(goal)} ETH</strong></div>
        <div><span class="label">ความคืบหน้า</span><strong>${pct}%</strong></div>
        <div><span class="label">ผู้สนับสนุน</span><strong>${backerCount} คน</strong></div>
        <div>
          <span class="label">เวลาระดมทุนที่เหลือ</span>
          <strong>${fundingOpen ? `<span data-deadline="${campaign.deadline}"></span>` : fundingClosedLabel}</strong>
        </div>
      </div>
      <p class="muted">ปิดระดมทุน ${formatDate(campaign.deadline)} · โหวตแต่ละรอบนาน ${formatDuration(Number(campaign.votingPeriod))}</p>
    </section>`;
}

function roleHtml({ isOwner, myContribution, campaign }) {
  if (!state.account) {
    return '<p class="role">ยังไม่ได้เชื่อมต่อ Wallet <button type="button" class="small" data-action="connect">เชื่อมต่อ</button></p>';
  }
  if (isOwner) return '<p class="role">คุณคือ <strong>เจ้าของโครงการ</strong></p>';
  if (myContribution > 0n) {
    const weight = percent(myContribution, campaign.totalRaised);
    return `<p class="role">คุณสนับสนุน <strong>${formatEth(myContribution)} ETH</strong> · น้ำหนักโหวต ${weight}%</p>`;
  }
  return '<p class="role">คุณยังไม่ได้สนับสนุนโครงการนี้</p>';
}

function contributeHtml({ campaign, isOwner }) {
  const remaining = campaign.goal - campaign.totalRaised;
  if (isOwner) {
    return '<p class="muted">เจ้าของโครงการสนับสนุนโครงการตัวเองไม่ได้ เพราะจะได้สิทธิ์โหวต Milestone ของตัวเอง</p>';
  }
  return `
    <h3>สนับสนุนเงินทุน <span class="req">ข้อ 2</span></h3>
    <div class="inline-form">
      <input id="contributeAmount" inputmode="decimal" placeholder="จำนวน ETH" />
      <button type="button" data-action="contribute" data-busy-lock>สนับสนุน</button>
    </div>
    <p class="hint">รับได้อีกไม่เกิน ${formatEth(remaining)} ETH</p>`;
}

function requestHtml({ current, currentIndex }) {
  const status = MILESTONE_STATUS[Number(current.status)];
  const retry = status === "Rejected"
    ? `<p class="warn">ครั้งที่แล้วไม่ผ่าน (ส่งไปแล้ว ${current.attempts} ครั้ง) ส่งหลักฐานใหม่ได้</p>`
    : "";
  return `
    <h3>ขอเบิกเงิน Milestone ${currentIndex + 1} <span class="req">ข้อ 4</span></h3>
    <p>${esc(current.description)} · งบ ${formatEth(current.amount)} ETH</p>
    ${retry}
    <div class="inline-form">
      <input id="evidenceInput" placeholder="หลักฐาน เช่น https://... หรือ ipfs://..." />
      <button type="button" data-action="request" data-busy-lock>ส่งหลักฐานและเปิดโหวต</button>
    </div>
    <p class="hint">ต้องส่งก่อน ${formatDate(current.deadline)} (เหลือ <span data-deadline="${current.deadline}"></span>)</p>`;
}

function voteHtml({ campaign, current, currentIndex, myContribution, isOwner, voted }) {
  const total = campaign.totalRaised;
  const approvePct = percent(current.approveWeight, total);
  const rejectPct = percent(current.rejectWeight, total);
  const threshold = Number(state.approvalPercent);
  const closed = chainNow() >= Number(current.votingEndsAt);
  const passed = current.approveWeight * 100n > total * state.approvalPercent;
  const cannotPass = current.rejectWeight * 100n >= total * (100n - state.approvalPercent);
  const canFinalize = passed || cannotPass || closed;

  let voteButtons;
  if (voted) voteButtons = '<p class="ok">คุณโหวตรอบนี้แล้ว</p>';
  else if (closed) voteButtons = '<p class="muted">หมดเวลาโหวตแล้ว</p>';
  else if (isOwner || myContribution === 0n) voteButtons = '<p class="muted">โหวตได้เฉพาะผู้สนับสนุนโครงการนี้</p>';
  else {
    voteButtons = `
      <div class="inline-form">
        <button type="button" class="approve" data-action="vote-yes" data-busy-lock>อนุมัติ</button>
        <button type="button" class="reject" data-action="vote-no" data-busy-lock>ไม่อนุมัติ</button>
      </div>`;
  }

  let finalizeLabel = "ปิดโหวต";
  if (passed) finalizeLabel = "ปิดโหวตและจ่ายเงินให้เจ้าของ";
  else if (canFinalize) finalizeLabel = "ปิดโหวต (ไม่ผ่าน)";

  return `
    <h3>โหวต Milestone ${currentIndex + 1} <span class="req">ข้อ 5</span></h3>
    <p>${esc(current.description)} · งบ ${formatEth(current.amount)} ETH · ส่งครั้งที่ ${current.attempts}</p>
    <p>หลักฐาน: ${evidenceHtml(current.evidence)}</p>
    <div class="vote-bar" title="ต้องอนุมัติเกิน ${threshold}% ของเงินทั้งหมด">
      <span class="yes" style="width:${approvePct}%"></span>
      <span class="no" style="width:${rejectPct}%"></span>
      <span class="threshold" style="left:${threshold}%"></span>
    </div>
    <p class="vote-legend">
      <span class="dot yes"></span>อนุมัติ ${approvePct}%
      <span class="dot no"></span>ไม่อนุมัติ ${rejectPct}%
      <span class="muted">· ต้องอนุมัติเกิน ${threshold}% ของเงินทั้งหมด</span>
    </p>
    <p class="hint">ปิดโหวต ${formatDate(current.votingEndsAt)} (เหลือ <span data-deadline="${current.votingEndsAt}"></span>)</p>
    ${voteButtons}
    <div class="inline-form">
      <button type="button" class="ghost" data-action="finalize" data-busy-lock ${canFinalize ? "" : "data-blocked disabled"}>${finalizeLabel}</button>
    </div>
    <p class="hint">ใครกดก็ได้ เมื่อผลชัดแล้วหรือหมดเวลาโหวต</p>`;
}

function refundHtml({ campaign, myContribution, myRefund, refunded, currentIndex }) {
  const reason = campaign.totalRaised < campaign.goal
    ? "ระดมทุนไม่ถึงเป้าภายในเวลา ผู้สนับสนุนได้เงินคืนเต็มจำนวน"
    : `Milestone ${currentIndex + 1} เลย deadline ผู้สนับสนุนได้เงินคืนตามสัดส่วนของเงินที่เหลือ`;
  let body;
  if (!state.account) body = "";
  else if (myContribution === 0n) body = '<p class="muted">คุณไม่ได้สนับสนุนโครงการนี้</p>';
  else if (refunded) body = '<p class="ok">คุณรับเงินคืนแล้ว</p>';
  else {
    body = `
      <p>ยอดที่คุณขอคืนได้: <strong>${formatEth(myRefund)} ETH</strong> (สนับสนุนไว้ ${formatEth(myContribution)} ETH)</p>
      <button type="button" data-action="refund" data-busy-lock>ขอรับเงินคืน</button>`;
  }
  return `<h3>คืนเงิน <span class="req">ข้อ 6</span></h3><p class="warn">${reason}</p>${body}`;
}

function actionCard(ctx) {
  const parts = [roleHtml(ctx)];
  const { status, current, isOwner, currentIndex } = ctx;
  if (status === "Funding") parts.push(contributeHtml(ctx));
  if (status === "Active" && current) {
    if (MILESTONE_STATUS[Number(current.status)] === "Voting") parts.push(voteHtml(ctx));
    else if (isOwner) parts.push(requestHtml(ctx));
    else parts.push(`<p class="muted">รอเจ้าของโครงการส่งหลักฐานของ Milestone ${currentIndex + 1}</p>`);
  }
  if (status === "Failed") parts.push(refundHtml(ctx));
  if (status === "Completed") parts.push('<p class="ok">โครงการสำเร็จ จ่ายเงินครบทุก Milestone แล้ว</p>');
  return card("สิ่งที่คุณทำได้", parts.join(""));
}

function milestonesCard({ milestones, campaign, currentIndex, status }) {
  const rows = milestones
    .map((m, i) => {
      const mStatus = MILESTONE_STATUS[Number(m.status)];
      const votes = m.attempts > 0n
        ? `${percent(m.approveWeight, campaign.totalRaised)}% / ${percent(m.rejectWeight, campaign.totalRaised)}%`
        : "-";
      const isCurrent = i === currentIndex && (status === "Active" || status === "Failed");
      return `
        <tr class="${isCurrent ? "current" : ""}">
          <td>${i + 1}</td>
          <td>${esc(m.description)}</td>
          <td class="num">${formatEth(m.amount)}</td>
          ${dateCell(m.deadline)}
          <td>${statusBadge(mStatus, MILESTONE_STATUS_TH)}</td>
          <td>${evidenceHtml(m.evidence)}</td>
          <td class="num">${votes}</td>
          <td class="num">${m.attempts}</td>
        </tr>`;
    })
    .join("");
  return card(
    'Milestones <span class="req">ข้อ 7</span>',
    `<div class="table-wrap"><table>
      <thead><tr><th>#</th><th>รายละเอียด</th><th>งบ (ETH)</th><th>Deadline</th><th>สถานะ</th><th>หลักฐาน</th><th>อนุมัติ / ไม่อนุมัติ</th><th>ส่งแล้ว</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`
  );
}

function moneyCard({ campaign }) {
  const held = campaign.totalRaised - campaign.totalReleased - campaign.totalRefunded;
  return card(
    'ความโปร่งใสทางการเงิน <span class="req">ข้อ 7</span>',
    `<div class="stats money">
      <div><span class="label">เงินเข้าทั้งหมด</span><strong class="in">${formatEth(campaign.totalRaised)} ETH</strong></div>
      <div><span class="label">จ่ายเจ้าของแล้ว</span><strong class="out">${formatEth(campaign.totalReleased)} ETH</strong></div>
      <div><span class="label">คืนผู้สนับสนุนแล้ว</span><strong class="out">${formatEth(campaign.totalRefunded)} ETH</strong></div>
      <div><span class="label">คงเหลือใน contract</span><strong>${formatEth(held)} ETH</strong></div>
    </div>`
  );
}

function historyRow(event, campaign) {
  const a = event.args;
  const milestone = (index) => `Milestone ${Number(index) + 1}`;
  let label;
  let who = "";
  let amount = "";
  switch (event.fragment.name) {
    case "Contributed":
      label = "เงินเข้า";
      who = addressHtml(a.backer);
      amount = `<span class="in">+${formatEth(a.amount)}</span>`;
      break;
    case "MilestoneReleaseRequested":
      label = `ขอเบิก ${milestone(a.milestoneIndex)} (ครั้งที่ ${a.attempt}) · ${evidenceHtml(a.evidence)}`;
      who = addressHtml(campaign.owner);
      break;
    case "MilestoneVoted":
      label = `โหวต${a.approve ? "อนุมัติ" : "ไม่อนุมัติ"} ${milestone(a.milestoneIndex)}`;
      who = addressHtml(a.backer);
      amount = `<span class="muted">น้ำหนัก ${formatEth(a.weight)}</span>`;
      break;
    case "MilestoneRejected":
      label = `${milestone(a.milestoneIndex)} ไม่ผ่าน (ครั้งที่ ${a.attempt})`;
      break;
    case "MilestoneReleased":
      label = `จ่ายเจ้าของ ${milestone(a.milestoneIndex)}`;
      who = addressHtml(a.owner);
      amount = `<span class="out">−${formatEth(a.amount)}</span>`;
      break;
    case "Refunded":
      label = "คืนเงิน";
      who = addressHtml(a.backer);
      amount = `<span class="out">−${formatEth(a.amount)}</span>`;
      break;
    default:
      label = esc(event.fragment.name);
  }
  return `
    <tr>
      ${dateCell(state.blockTimes.get(event.blockNumber))}
      <td>${label}</td>
      <td>${who}</td>
      <td class="num">${amount}</td>
      <td>${txHtml(event.transactionHash)}</td>
    </tr>`;
}

function historyCard({ history, historyError, campaign }) {
  let body;
  if (historyError) {
    body = `<p class="warn">โหลดประวัติไม่ได้: ${esc(historyError)} ลองใส่ "บล็อกที่ deploy" ให้ถูกต้อง</p>`;
  } else if (history.length === 0) {
    body = '<p class="muted">ยังไม่มีรายการ</p>';
  } else {
    body = `<div class="table-wrap"><table>
      <thead><tr><th>เวลา</th><th>รายการ</th><th>โดย</th><th>ETH</th><th>Tx</th></tr></thead>
      <tbody>${history.map((e) => historyRow(e, campaign)).join("")}</tbody>
    </table></div>`;
  }
  return card('ประวัติเงินเข้า-ออกและการโหวต <span class="req">ข้อ 7</span>', body);
}

function tickCountdowns() {
  const now = chainNow();
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    el.textContent = formatDuration(Number(el.dataset.deadline) - now);
  });
}

// ---------------------------------------------------------------------------
// Create campaign form (requirement 1)
// ---------------------------------------------------------------------------

function milestoneRowHtml(index) {
  return `
    <div class="milestone-row">
      <span class="index">${index + 1}</span>
      <input name="mDescription" placeholder="รายละเอียด เช่น Prototype" maxlength="200" />
      <input name="mAmount" inputmode="decimal" placeholder="งบ ETH" />
      <input name="mMinutes" type="number" min="1" step="1" placeholder="นาที" value="30" title="เวลาทำงาน (นาที)" />
      <button type="button" class="ghost small" data-remove-row aria-label="ลบ Milestone">×</button>
    </div>`;
}

function renumberMilestoneRows() {
  document.querySelectorAll("#milestoneRows .milestone-row").forEach((row, i) => {
    row.querySelector(".index").textContent = String(i + 1);
  });
}

function addMilestoneRow() {
  const container = $("#milestoneRows");
  if (container.children.length >= 10) return;
  container.insertAdjacentHTML("beforeend", milestoneRowHtml(container.children.length));
  updateMilestoneTotal();
}

function parseEthInput(text) {
  try {
    return ethers.parseEther(String(text).trim());
  } catch {
    return null;
  }
}

function updateMilestoneTotal() {
  const form = $("#createForm");
  const goal = parseEthInput(form.goal.value);
  let total = 0n;
  let valid = true;
  form.querySelectorAll('[name="mAmount"]').forEach((input) => {
    if (input.value.trim() === "") return; // not filled in yet
    const amount = parseEthInput(input.value);
    if (amount === null) valid = false;
    else total += amount;
  });
  const el = $("#milestoneTotal");
  if (!valid) {
    el.className = "total warn";
    el.textContent = "งบของ Milestone ต้องเป็นตัวเลข เช่น 1.5";
    return;
  }
  if (goal === null) {
    el.className = "total";
    el.textContent = `งบรวม ${formatEth(total)} ETH · ใส่เป้าหมายเพื่อเทียบ`;
    return;
  }
  const match = total === goal;
  el.className = `total ${match ? "ok" : "warn"}`;
  el.textContent = match
    ? `งบรวม ${formatEth(total)} ETH เท่ากับเป้าหมาย ✓`
    : `งบรวม ${formatEth(total)} ETH ยังไม่เท่ากับเป้าหมาย ${formatEth(goal)} ETH`;
}

function readCreateForm() {
  const form = $("#createForm");
  const title = form.title.value.trim();
  const goal = parseEthInput(form.goal.value);
  const fundingSeconds = Math.round(Number(form.fundingMinutes.value) * 60);
  const votingSeconds = Math.round(Number(form.votingMinutes.value) * 60);
  if (!title) throw new Error("ใส่ชื่อโครงการ");
  if (!goal || goal <= 0n) throw new Error("ใส่เป้าหมายเป็นจำนวน ETH ที่มากกว่า 0");
  if (!(fundingSeconds > 0) || !(votingSeconds > 0)) throw new Error("ระยะเวลาต้องมากกว่า 0 นาที");

  const milestones = [...form.querySelectorAll(".milestone-row")].map((row, i) => {
    const description = row.querySelector('[name="mDescription"]').value.trim();
    const amount = parseEthInput(row.querySelector('[name="mAmount"]').value);
    const duration = Math.round(Number(row.querySelector('[name="mMinutes"]').value) * 60);
    if (!description) throw new Error(`ใส่รายละเอียด Milestone ${i + 1}`);
    if (!amount || amount <= 0n) throw new Error(`ใส่งบ Milestone ${i + 1} ให้มากกว่า 0`);
    if (!(duration > 0)) throw new Error(`ใส่เวลาทำงาน Milestone ${i + 1} ให้มากกว่า 0 นาที`);
    return { description, amount, duration };
  });
  if (milestones.length === 0) throw new Error("ต้องมีอย่างน้อย 1 Milestone");
  const total = milestones.reduce((sum, m) => sum + m.amount, 0n);
  if (total !== goal) throw new Error("งบของ Milestone รวมกันต้องเท่ากับเป้าหมาย");

  return [title, form.description.value.trim(), goal, fundingSeconds, votingSeconds, milestones];
}

async function submitCreateForm(event) {
  event.preventDefault();
  if (!state.contract) {
    showToast("โหลด contract ก่อน", "error");
    return;
  }
  let args;
  try {
    args = readCreateForm();
  } catch (err) {
    showToast(esc(err.message), "error");
    return;
  }
  const receipt = await send("สร้างโครงการ", "createCampaign", args);
  if (!receipt) return;

  const created = receipt.logs
    .map((log) => {
      try {
        return state.contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((log) => log?.name === "CampaignCreated");
  $("#createForm").reset();
  $("#milestoneRows").innerHTML = "";
  addMilestoneRow();
  addMilestoneRow();
  if (created) selectCampaign(Number(created.args.campaignId));
}

// ---------------------------------------------------------------------------
// Detail panel actions
// ---------------------------------------------------------------------------

async function handleAction(action) {
  const id = state.selectedId;
  switch (action) {
    case "connect":
      return connect();
    case "contribute": {
      const amount = parseEthInput($("#contributeAmount").value);
      if (!amount || amount <= 0n) return showToast("ใส่จำนวน ETH ที่มากกว่า 0", "error");
      return send("สนับสนุนเงินทุน", "contribute", [id], { value: amount });
    }
    case "request": {
      const evidence = $("#evidenceInput").value.trim();
      if (!evidence) return showToast("ใส่หลักฐานความสำเร็จ", "error");
      return send("ส่งหลักฐาน", "requestRelease", [id, evidence]);
    }
    case "vote-yes":
      return send("โหวตอนุมัติ", "voteOnMilestone", [id, true]);
    case "vote-no":
      return send("โหวตไม่อนุมัติ", "voteOnMilestone", [id, false]);
    case "finalize":
      return send("ปิดโหวต", "finalizeMilestone", [id]);
    case "refund":
      return send("ขอรับเงินคืน", "claimRefund", [id]);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

function autoRefresh() {
  const typing = document.activeElement?.matches("input, textarea");
  if (document.hidden || state.busy || typing) return;
  refresh().catch(() => {});
}

function bindEvents() {
  $("#connectBtn").addEventListener("click", connect);
  $("#refreshBtn").addEventListener("click", () =>
    refresh().catch((err) => showToast(esc(errorMessage(err)), "error"))
  );
  $("#loadContractBtn").addEventListener("click", () =>
    loadContract($("#contractInput").value.trim(), Number($("#fromBlockInput").value) || 0)
      .catch((err) => showNotice(errorMessage(err), "error"))
  );
  $("#campaignList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-select]");
    if (button) selectCampaign(Number(button.dataset.select));
  });
  $("#detail").addEventListener("click", (event) => {
    const button = event.target.closest("[data-action]");
    if (button && !button.disabled) handleAction(button.dataset.action);
  });

  const form = $("#createForm");
  form.addEventListener("submit", submitCreateForm);
  form.addEventListener("input", updateMilestoneTotal);
  $("#addMilestoneBtn").addEventListener("click", addMilestoneRow);
  $("#milestoneRows").addEventListener("click", (event) => {
    if (!event.target.matches("[data-remove-row]")) return;
    if ($("#milestoneRows").children.length <= 1) return;
    event.target.closest(".milestone-row").remove();
    renumberMilestoneRows();
    updateMilestoneTotal();
  });
}

async function init() {
  bindEvents();
  addMilestoneRow();
  addMilestoneRow();
  renderEmptyDetail();

  if (!window.ethereum) {
    showNotice("ไม่พบ Wallet ในเบราว์เซอร์นี้ ติดตั้ง MetaMask แล้วรีเฟรชหน้า", "error");
    return;
  }

  state.provider = new ethers.BrowserProvider(window.ethereum);
  state.chainId = Number((await state.provider.getNetwork()).chainId);
  window.ethereum.on?.("accountsChanged", async (accounts) => {
    await setAccount(accounts[0]);
    refresh().catch(() => {});
  });
  window.ethereum.on?.("chainChanged", () => location.reload());

  const accounts = await state.provider.send("eth_accounts", []);
  await setAccount(accounts[0]);

  const hash = location.hash.match(/^#campaign-(\d+)$/);
  state.selectedId = hash ? Number(hash[1]) : null;

  const params = new URLSearchParams(location.search);
  const saved = readSaved();
  const address = params.get("address") || saved.address || CONFIG.contractAddress;
  const fromBlock = Number(params.get("fromBlock") ?? saved.fromBlock ?? CONFIG.fromBlock) || 0;
  if (address) {
    await loadContract(address, fromBlock).catch((err) => showNotice(errorMessage(err), "error"));
  } else {
    showNotice("ใส่ address ของ contract ที่ deploy แล้วในช่องด้านบน แล้วกดโหลด", "info");
  }

  setInterval(tickCountdowns, 1000);
  setInterval(autoRefresh, REFRESH_MS);
}

init().catch((err) => showNotice(errorMessage(err), "error"));
