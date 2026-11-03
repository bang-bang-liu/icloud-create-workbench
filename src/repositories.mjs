import { createHash, randomUUID } from "node:crypto";

/** 生成稳定但不可逆的账号去重键。 */
export function accountIdentityKey(region, dsid, appleId) {
  return createHash("sha256").update(`${region}:${dsid || appleId}`).digest("hex");
}

/** 创建业务数据仓库。 */
export function createRepositories(db) {
  /** 将活动任务唯一约束冲突转换为统一的业务错误。 */
  function throwTaskConflict(error) {
    if (error?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      throw Object.assign(new Error("该 CK 已有未结束任务"), { status: 409 });
    }
    throw error;
  }
  const accountSummarySql = `
    SELECT a.id, a.apple_id AS appleId, a.display_name AS displayName,
      a.region, a.user_partition AS userPartition, a.maildomain_host AS maildomainHost,
      a.status, a.label_prefix AS labelPrefix, a.cooldown_until AS cooldownUntil,
      a.last_checked_at AS lastCheckedAt, a.created_at AS createdAt, a.updated_at AS updatedAt,
      COUNT(DISTINCT h.id) AS addressCount,
      SUM(CASE WHEN h.local_state = 'unused' THEN 1 ELSE 0 END) AS unusedCount,
      (SELECT status FROM generation_jobs j WHERE j.account_id = a.id ORDER BY j.created_at DESC LIMIT 1) AS latestJobStatus
    FROM icloud_accounts a
    LEFT JOIN hidden_addresses h ON h.account_id = a.id
  `;

  /** 列出未删除的 iCloud 账号摘要。 */
  function listAccounts() {
    return db.prepare(`${accountSummarySql} WHERE a.status != 'deleted' GROUP BY a.id ORDER BY a.created_at DESC`).all();
  }

  /** 按编号读取账号内部数据。 */
  function getAccountInternal(id) {
    return db.prepare("SELECT * FROM icloud_accounts WHERE id = ?").get(id);
  }

  /** 按编号读取可返回给前端的账号摘要。 */
  function getAccount(id) {
    return db.prepare(`${accountSummarySql} WHERE a.id = ? GROUP BY a.id`).get(id);
  }

  /** 新增或更新一条经过校验的 CK 账号。 */
  function upsertAccount(input) {
    const now = new Date().toISOString();
    const existing = db.prepare("SELECT id FROM icloud_accounts WHERE identity_key = ?").get(input.identityKey);
    if (existing) {
      db.prepare(`UPDATE icloud_accounts SET apple_id = ?, dsid = ?, display_name = ?, region = ?,
        user_partition = ?, maildomain_host = ?, cookie_encrypted = ?, status = 'active', last_checked_at = ?, updated_at = ?
        WHERE id = ?`).run(input.appleId, input.dsid || "", input.displayName || "", input.region,
        input.userPartition || "", input.maildomainHost || "", input.cookieEncrypted, now, now, existing.id);
      return getAccountInternal(existing.id);
    }
    const id = randomUUID();
    const labelPrefix = String(input.appleId || "").split("@")[0]
      .replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24) || "icloud";
    db.prepare(`INSERT INTO icloud_accounts
      (id, apple_id, identity_key, dsid, display_name, region, user_partition, maildomain_host,
       cookie_encrypted, status, label_prefix, label_sequence, last_checked_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, 0, ?, ?, ?)`)
      .run(id, input.appleId, input.identityKey, input.dsid || "", input.displayName || "", input.region,
        input.userPartition || "", input.maildomainHost || "", input.cookieEncrypted, labelPrefix, now, now, now);
    return getAccountInternal(id);
  }

  /** 更新账号检测结果与加密 CK。 */
  function updateAccountCookie(id, input) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE icloud_accounts SET apple_id = ?, dsid = ?, display_name = ?, region = ?,
      user_partition = ?, maildomain_host = ?, identity_key = ?, cookie_encrypted = ?, status = 'active',
      last_checked_at = ?, updated_at = ? WHERE id = ?`).run(input.appleId, input.dsid || "",
      input.displayName || "", input.region, input.userPartition || "", input.maildomainHost || "",
      input.identityKey, input.cookieEncrypted, now, now, id);
    return getAccountInternal(id);
  }

  /** 将最近一次 Apple 请求失败的 CK 标记为已过期。 */
  function markAccountExpired(id) {
    const now = new Date().toISOString();
    db.prepare(`UPDATE icloud_accounts SET apple_id = CASE WHEN apple_id LIKE '%***%' THEN '无法获取（CK 已过期）'
      ELSE apple_id END, status = 'expired', last_checked_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id);
  }
  /** 软删除账号并清除其加密 CK。 */
  function deleteAccount(id) {
    return db.prepare("UPDATE icloud_accounts SET status = 'deleted', cookie_encrypted = '', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id).changes > 0;
  }

  /** 保存经 Apple 接口验证可用的 maildomain 分片。 */
  function updateMaildomainHost(id, maildomainHost) {
    if (!maildomainHost) return;
    db.prepare("UPDATE icloud_accounts SET maildomain_host = ?, updated_at = ? WHERE id = ?")
      .run(maildomainHost, new Date().toISOString(), id);
  }

  /** 创建一条等待执行的生成任务。 */
  function createJob(accountId, requestedCount) {
    const job = { id: randomUUID(), accountId, requestedCount, status: "queued", createdAt: new Date().toISOString() };
    try {
      db.prepare(`INSERT INTO generation_jobs (id, account_id, requested_count, status, created_at)
        VALUES (?, ?, ?, ?, ?)`).run(job.id, accountId, requestedCount, job.status, job.createdAt);
    } catch (error) {
      throwTaskConflict(error);
    }
    return job;
  }

  /** 原子占用批次任务名额并分配连续标签。 */
  function createJobWithLabels(accountId, prefix, count) {
    try {
      return db.transaction(() => {
        const job = createJob(accountId, count);
        const labels = allocateLabels(accountId, prefix, count);
        return { job, labels };
      })();
    } catch (error) {
      throwTaskConflict(error);
    }
  }

  /** 原子分配一批连续标签并更新账号前缀。 */
  function allocateLabels(accountId, prefix, count) {
    return db.transaction(() => {
      const account = db.prepare("SELECT label_sequence FROM icloud_accounts WHERE id = ?").get(accountId);
      if (!account) throw new Error("iCloud 账号不存在");
      const start = Number(account.label_sequence || 0) + 1;
      const labels = Array.from({ length: count }, (_, index) => `${prefix}-${String(start + index).padStart(3, "0")}`);
      db.prepare("UPDATE icloud_accounts SET label_prefix = ?, label_sequence = ?, updated_at = ? WHERE id = ?")
        .run(prefix, start + count - 1, new Date().toISOString(), accountId);
      return labels;
    })();
  }

  /** 将任务标记为运行中。 */
  function startJob(id) {
    const startedAt = new Date().toISOString();
    db.prepare("UPDATE generation_jobs SET status = 'running', started_at = ? WHERE id = ?").run(startedAt, id);
    return startedAt;
  }

  /** 完成任务并在成功时设置账号冷却。 */
  function finishJob(id, accountId, result, cooldownMinutes) {
    const finishedAt = new Date().toISOString();
    const successCount = result.generated.length;
    const status = successCount === 0 ? "failed" : result.errors.length ? "partial" : "success";
    const firstSuccessAt = successCount ? result.generated[0].createdAt || finishedAt : null;
    const errorSummary = result.errors.map(item => item.error).join("；").slice(0, 1000);
    const transaction = db.transaction(() => {
      db.prepare(`UPDATE generation_jobs SET status = ?, error_summary = ?, finished_at = ?, first_success_at = ? WHERE id = ?`)
        .run(status, errorSummary, finishedAt, firstSuccessAt, id);
      if (firstSuccessAt) {
        const cooldownUntil = new Date(new Date(firstSuccessAt).getTime() + cooldownMinutes * 60_000).toISOString();
        db.prepare("UPDATE icloud_accounts SET cooldown_until = ?, updated_at = ? WHERE id = ?")
          .run(cooldownUntil, finishedAt, accountId);
      }
      const insertResult = db.prepare(`INSERT INTO generation_results
        (id, job_id, label, email, status, error_text, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const item of result.generated) {
        insertResult.run(randomUUID(), id, item.label || "", item.email || "", "success", "", item.createdAt || finishedAt);
      }
      for (const item of result.errors) {
        insertResult.run(randomUUID(), id, item.label || "", "", "failed", String(item.error || "生成失败"), finishedAt);
      }
    });
    transaction();
    return { status, finishedAt };
  }

  /** 将异常中断的运行任务恢复为失败。 */
  function recoverRunningJobs() {
    return db.prepare("UPDATE generation_jobs SET status = 'failed', error_summary = '服务重启，任务已中断', finished_at = ? WHERE status IN ('queued', 'running')")
      .run(new Date().toISOString()).changes;
  }

  /** 回收超过安全时限仍未结束的遗留任务，避免长期占用 CK 的任务名额。 */
  function recoverStaleJobs(accountId, staleMinutes = 10) {
    const cutoff = new Date(Date.now() - staleMinutes * 60_000).toISOString();
    return db.prepare(`UPDATE generation_jobs SET status = 'failed', error_summary = '任务超时，系统已自动回收', finished_at = ?
      WHERE account_id = ? AND status IN ('queued', 'running') AND COALESCE(started_at, created_at) <= ?`)
      .run(new Date().toISOString(), accountId, cutoff).changes;
  }

  /** 判断账号当前是否已有运行任务。 */
  function hasRunningJob(accountId) {
    return Boolean(db.prepare("SELECT 1 FROM generation_jobs WHERE account_id = ? AND status IN ('queued', 'running') LIMIT 1").get(accountId));
  }

  /** 查询账号最近的生成任务。 */
  function listJobs(accountId, limit = 30) {
    const jobs = db.prepare(`SELECT id, account_id AS accountId, requested_count AS requestedCount, status,
      error_summary AS errorSummary, started_at AS startedAt, finished_at AS finishedAt,
      first_success_at AS firstSuccessAt, created_at AS createdAt
      FROM generation_jobs WHERE account_id = ? ORDER BY created_at DESC LIMIT ?`).all(accountId, limit);
    const resultStatement = db.prepare(`SELECT label, email, status, error_text AS error, created_at AS createdAt
      FROM generation_results WHERE job_id = ? ORDER BY created_at`);
    return jobs.map(job => ({ ...job, results: resultStatement.all(job.id) }));
  }

  /** 查询所有账号的最近生成任务，供任务中心展示。 */
  function listAllJobs(limit = 100) {
    const jobs = db.prepare(`SELECT j.id, j.account_id AS accountId, j.requested_count AS requestedCount,
      j.status, j.error_summary AS errorSummary, j.started_at AS startedAt, j.finished_at AS finishedAt,
      j.first_success_at AS firstSuccessAt, j.created_at AS createdAt, a.apple_id AS appleId
      FROM generation_jobs j LEFT JOIN icloud_accounts a ON a.id = j.account_id
      ORDER BY j.created_at DESC LIMIT ?`).all(limit);
    const resultStatement = db.prepare(`SELECT label, email, status, error_text AS error, created_at AS createdAt
      FROM generation_results WHERE job_id = ? ORDER BY created_at`);
    return jobs.map(job => ({ ...job, results: resultStatement.all(job.id) }));
  }

  /** 分页查询所有账号的生成执行记录。 */
  function pageAllJobs(page = 1, pageSize = 20) {
    const total = Number(db.prepare("SELECT COUNT(*) AS count FROM generation_jobs").get().count || 0);
    const offset = (page - 1) * pageSize;
    const jobs = db.prepare(`SELECT j.id, j.account_id AS accountId, j.requested_count AS requestedCount,
      j.status, j.error_summary AS errorSummary, j.started_at AS startedAt, j.finished_at AS finishedAt,
      j.first_success_at AS firstSuccessAt, j.created_at AS createdAt, a.apple_id AS appleId
      FROM generation_jobs j LEFT JOIN icloud_accounts a ON a.id = j.account_id
      ORDER BY j.created_at DESC LIMIT ? OFFSET ?`).all(pageSize, offset);
    const resultStatement = db.prepare(`SELECT label, email, status, error_text AS error, created_at AS createdAt
      FROM generation_results WHERE job_id = ? ORDER BY created_at`);
    return { rows: jobs.map(job => ({ ...job, results: resultStatement.all(job.id) })), total, page, pageSize };
  }

  /** 返回指定账号当前保存的隐藏邮箱数量。 */
  function countAddresses(accountId) {
    return Number(db.prepare("SELECT COUNT(*) AS count FROM hidden_addresses WHERE account_id = ?").get(accountId)?.count || 0);
  }

  /** 创建一个持续生产目标。 */
  function createCampaign(input) {
    const now = new Date().toISOString();
    const campaign = { id: randomUUID(), ...input, status: "running", createdAt: now };
    try {
      db.prepare(`INSERT INTO generation_campaigns
        (id, account_id, target_total, batch_size, label_prefix, status, next_run_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'running', ?, ?, ?)`)
        .run(campaign.id, input.accountId, input.targetTotal, input.batchSize, input.labelPrefix, input.nextRunAt, now, now);
    } catch (error) {
      throwTaskConflict(error);
    }
    return campaign;
  }

  /** 查找账号尚未完成的生产目标。 */
  function findOpenCampaign(accountId) {
    return db.prepare("SELECT * FROM generation_campaigns WHERE account_id = ? AND status IN ('running', 'stopped') ORDER BY created_at DESC LIMIT 1").get(accountId);
  }

  /** 读取单个生产目标内部状态。 */
  function getCampaignInternal(id) {
    return db.prepare("SELECT * FROM generation_campaigns WHERE id = ?").get(id);
  }

  /** 列出生产目标及实时库存进度。 */
  function listCampaigns(limit = 100) {
    return db.prepare(`SELECT c.id, c.account_id AS accountId, c.target_total AS targetTotal,
      c.batch_size AS batchSize, c.label_prefix AS labelPrefix, c.status,
      c.generated_count AS generatedCount, c.last_error AS lastError,
      c.next_run_at AS nextRunAt, c.last_run_at AS lastRunAt,
      c.created_at AS createdAt, c.updated_at AS updatedAt,
      a.apple_id AS appleId, a.cooldown_until AS cooldownUntil,
      (SELECT COUNT(*) FROM hidden_addresses h WHERE h.account_id = c.account_id) AS currentTotal
      FROM generation_campaigns c LEFT JOIN icloud_accounts a ON a.id = c.account_id
      ORDER BY c.created_at DESC LIMIT ?`).all(limit);
  }

  /** 读取当前到期且需要执行的生产目标。 */
  function listDueCampaigns(now, limit = 5) {
    return db.prepare(`SELECT * FROM generation_campaigns
      WHERE status = 'running' AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at, created_at LIMIT ?`).all(now, limit);
  }

  /** 停止生产目标的后续批次。 */
  function stopCampaign(id) {
    return db.prepare("UPDATE generation_campaigns SET status = 'stopped', next_run_at = NULL, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(new Date().toISOString(), id).changes > 0;
  }

  /** 继续已停止的生产目标。 */
  function resumeCampaign(id, nextRunAt) {
    return db.prepare("UPDATE generation_campaigns SET status = 'running', next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND status = 'stopped'")
      .run(nextRunAt, new Date().toISOString(), id).changes > 0;
  }

  /** 更新未完成目标及所属 CK 的默认标签前缀。 */
  function updateCampaignLabelPrefix(id, labelPrefix) {
    return db.transaction(() => {
      const campaign = db.prepare("SELECT account_id FROM generation_campaigns WHERE id = ? AND status IN ('running', 'stopped')").get(id);
      if (!campaign) return false;
      const now = new Date().toISOString();
      db.prepare("UPDATE generation_campaigns SET label_prefix = ?, updated_at = ? WHERE id = ?")
        .run(labelPrefix, now, id);
      db.prepare("UPDATE icloud_accounts SET label_prefix = ?, updated_at = ? WHERE id = ?")
        .run(labelPrefix, now, campaign.account_id);
      return true;
    })();
  }

  /** 删除指定生产目标，不触碰邮箱库存和批次记录。 */
  function deleteCampaign(id) {
    return db.prepare("DELETE FROM generation_campaigns WHERE id = ?").run(id).changes > 0;
  }

  /** 标记目标已达到库存总数。 */
  function completeCampaign(id) {
    db.prepare("UPDATE generation_campaigns SET status = 'completed', next_run_at = NULL, last_error = NULL, updated_at = ? WHERE id = ? AND status != 'stopped'")
      .run(new Date().toISOString(), id);
  }

  /** 记录一个自动批次结果并安排下一次执行。 */
  function recordCampaignRun(id, generatedCount, nextRunAt, lastError = "") {
    const now = new Date().toISOString();
    db.prepare(`UPDATE generation_campaigns SET generated_count = generated_count + ?,
      last_run_at = ?, next_run_at = CASE WHEN status = 'stopped' THEN NULL ELSE ? END,
      last_error = ?, updated_at = ? WHERE id = ?`)
      .run(generatedCount, now, nextRunAt, String(lastError || "").slice(0, 1000), now, id);
  }

  /** 批量写入生成或同步得到的隐藏邮箱。 */
  function upsertAddresses(accountId, jobId, rows, source) {
    const statement = db.prepare(`INSERT INTO hidden_addresses
      (id, account_id, job_id, email, apple_label, local_state, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'unused', ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET account_id = excluded.account_id, apple_label = excluded.apple_label,
        updated_at = excluded.updated_at`);
    const transaction = db.transaction(items => {
      for (const item of items) {
        const now = item.createdAt || new Date().toISOString();
        statement.run(randomUUID(), accountId, jobId || null, item.email, item.label || "", source, now, now);
      }
    });
    transaction(rows);
  }

  /** 按条件查询隐藏邮箱。 */
  function listAddresses(filters = {}) {
    const where = ["1 = 1"];
    const values = [];
    if (filters.accountId) { where.push("h.account_id = ?"); values.push(filters.accountId); }
    if (["unused", "used", "trash"].includes(filters.state)) { where.push("h.local_state = ?"); values.push(filters.state); }
    if (filters.search) { where.push("(h.email LIKE ? OR h.apple_label LIKE ?)"); values.push(`%${filters.search}%`, `%${filters.search}%`); }
    return db.prepare(`SELECT h.id, h.account_id AS accountId, h.email, h.apple_label AS label,
      h.local_state AS state, h.source, h.created_at AS createdAt, a.apple_id AS appleId
      FROM hidden_addresses h LEFT JOIN icloud_accounts a ON a.id = h.account_id
      WHERE ${where.join(" AND ")} ORDER BY h.created_at DESC LIMIT 1000`).all(...values);
  }

  /** 按账号、状态和关键词分页查询隐藏邮箱。 */
  function pageAddresses(filters = {}, page = 1, pageSize = 20) {
    const where = ["1 = 1"];
    const values = [];
    if (filters.accountId) { where.push("h.account_id = ?"); values.push(filters.accountId); }
    if (["unused", "used", "trash"].includes(filters.state)) { where.push("h.local_state = ?"); values.push(filters.state); }
    if (filters.search) { where.push("(h.email LIKE ? OR h.apple_label LIKE ?)"); values.push(`%${filters.search}%`, `%${filters.search}%`); }
    const clause = where.join(" AND ");
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM hidden_addresses h WHERE ${clause}`).get(...values).count || 0);
    const rows = db.prepare(`SELECT h.id, h.account_id AS accountId, h.email, h.apple_label AS label,
      h.local_state AS state, h.source, h.created_at AS createdAt, a.apple_id AS appleId
      ,(SELECT COUNT(*) FROM inbox_messages m WHERE m.address_id = h.id) AS messageCount
      ,(SELECT m.received_at FROM inbox_messages m WHERE m.address_id = h.id ORDER BY m.received_at DESC LIMIT 1) AS latestMessageAt
      ,(SELECT m.code FROM inbox_messages m WHERE m.address_id = h.id ORDER BY m.received_at DESC LIMIT 1) AS latestCode
      ,EXISTS(SELECT 1 FROM address_public_access p WHERE p.address_id = h.id) AS publicAccessEnabled
      FROM hidden_addresses h LEFT JOIN icloud_accounts a ON a.id = h.account_id
      WHERE ${clause} ORDER BY h.created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  }

  /** 修改隐藏邮箱的本地状态。 */
  function updateAddressState(id, state) {
    return db.prepare("UPDATE hidden_addresses SET local_state = ?, updated_at = ? WHERE id = ?")
      .run(state, new Date().toISOString(), id).changes > 0;
  }

  /** 批量修改最多两百个隐藏邮箱的本地状态。 */
  function updateAddressStates(ids, state) {
    const statement = db.prepare("UPDATE hidden_addresses SET local_state = ?, updated_at = ? WHERE id = ?");
    return db.transaction(items => {
      let changes = 0;
      const now = new Date().toISOString();
      for (const id of items) changes += statement.run(state, now, id).changes;
      return changes;
    })(ids);
  }

  /** 读取邮箱详情及其所属 CK 摘要。 */
  function getAddress(id) {
    return db.prepare(`SELECT h.id, h.account_id AS accountId, h.email, h.apple_label AS label,
      h.local_state AS state, h.source, h.created_at AS createdAt, h.updated_at AS updatedAt,
      a.apple_id AS appleId, a.region,
      (SELECT COUNT(*) FROM inbox_messages m WHERE m.address_id = h.id) AS messageCount,
      (SELECT m.received_at FROM inbox_messages m WHERE m.address_id = h.id ORDER BY m.received_at DESC LIMIT 1) AS latestMessageAt,
      (SELECT m.code FROM inbox_messages m WHERE m.address_id = h.id ORDER BY m.received_at DESC LIMIT 1) AS latestCode,
      EXISTS(SELECT 1 FROM address_public_access p WHERE p.address_id = h.id) AS publicAccessEnabled
      FROM hidden_addresses h LEFT JOIN icloud_accounts a ON a.id = h.account_id WHERE h.id = ?`).get(id);
  }

  /** 分页读取指定隐私邮箱关联的邮件。 */
  function pageAddressMessages(addressId, page = 1, pageSize = 20) {
    const total = Number(db.prepare("SELECT COUNT(*) AS count FROM inbox_messages WHERE address_id = ?").get(addressId).count || 0);
    const rows = db.prepare(`SELECT id, subject, sender, code, preview, received_at AS receivedAt
      FROM inbox_messages WHERE address_id = ? ORDER BY received_at DESC LIMIT ? OFFSET ?`)
      .all(addressId, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  }

  /** 读取单封邮件的完整纯文本正文。 */
  function getMessage(id) {
    return db.prepare(`SELECT m.id, m.account_id AS accountId, m.address_id AS addressId,
      m.subject, m.sender, m.code, m.preview, m.body_text AS bodyText, m.body_html AS bodyHtml,
      m.received_at AS receivedAt,
      h.email AS hiddenEmail FROM inbox_messages m LEFT JOIN hidden_addresses h ON h.id = m.address_id
      WHERE m.id = ?`).get(id);
  }

  /** 创建或轮换邮箱公开访问密钥哈希。 */
  function savePublicAccess(addressId, tokenHash) {
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO address_public_access (address_id, token_hash, created_at)
      VALUES (?, ?, ?) ON CONFLICT(address_id) DO UPDATE SET token_hash = excluded.token_hash,
      rotated_at = excluded.created_at, last_access_at = NULL`).run(addressId, tokenHash, now);
  }

  /** 撤销邮箱公开访问。 */
  function revokePublicAccess(addressId) {
    return db.prepare("DELETE FROM address_public_access WHERE address_id = ?").run(addressId).changes > 0;
  }

  /** 使用邮箱和密钥哈希读取最新邮件。 */
  function getLatestPublicMail(email, tokenHash) {
    const access = db.prepare(`SELECT h.id AS addressId, h.email FROM hidden_addresses h
      JOIN address_public_access p ON p.address_id = h.id
      WHERE lower(h.email) = lower(?) AND p.token_hash = ?`).get(email, tokenHash);
    if (!access) return null;
    const message = db.prepare(`SELECT id, subject, sender, code, preview, body_text AS bodyText, body_html AS bodyHtml,
      received_at AS receivedAt FROM inbox_messages WHERE address_id = ? ORDER BY received_at DESC LIMIT 1`)
      .get(access.addressId) || null;
    db.prepare("UPDATE address_public_access SET last_access_at = ? WHERE address_id = ?")
      .run(new Date().toISOString(), access.addressId);
    return { email: access.email, message };
  }

  /** 读取全局 IMAP 配置内部数据。 */
  function getInboxConfigInternal(accountId) {
    return db.prepare("SELECT * FROM account_inbox_configs WHERE account_id = ?").get(accountId);
  }

  /** 列出所有已配置 IMAP 的 CK。 */
  function listInboxConfigs() {
    return db.prepare(`SELECT * FROM account_inbox_configs
      WHERE host IS NOT NULL AND email IS NOT NULL AND password_encrypted IS NOT NULL`).all();
  }

  /** 保存 IMAP 增量游标和下次同步时间。 */
  function updateInboxSyncState(accountId, input) {
    db.prepare(`UPDATE account_inbox_configs SET last_uid = ?, uid_validity = ?, last_sync_at = ?,
      next_sync_at = ?, last_error = ?, updated_at = ? WHERE account_id = ?`)
      .run(input.lastUid, input.uidValidity || "", input.lastSyncAt || null, input.nextSyncAt || null,
        input.lastError || "", new Date().toISOString(), accountId);
  }

  /** 重置 IMAP 增量游标并安排立即同步。 */
  function resetInboxSyncState(accountId) {
    db.prepare(`UPDATE account_inbox_configs SET last_uid = 0, uid_validity = NULL,
      next_sync_at = ?, last_error = '', updated_at = ? WHERE account_id = ?`)
      .run(new Date().toISOString(), new Date().toISOString(), accountId);
  }

  /** 标记现有邮件 HTML 一次性回填已经完成。 */
  function completeInboxHtmlBackfill(accountId) {
    db.prepare("UPDATE account_inbox_configs SET html_backfill_done = 1, updated_at = ? WHERE account_id = ?")
      .run(new Date().toISOString(), accountId);
  }

  /** 保存全局 IMAP 配置。 */
  function saveInboxConfig(accountId, input) {
    db.prepare(`INSERT INTO account_inbox_configs (account_id, host, port, secure, email, password_encrypted, mailbox, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET host = excluded.host, port = excluded.port, secure = excluded.secure,
        email = excluded.email, password_encrypted = excluded.password_encrypted, mailbox = excluded.mailbox,
        updated_at = excluded.updated_at`).run(accountId, input.host, input.port, input.secure ? 1 : 0, input.email,
      input.passwordEncrypted, input.mailbox, new Date().toISOString());
  }

  /** 写入一封同步到的邮件。 */
  function insertMessage(accountId, message, options = {}) {
    const address = message.recipient
      ? db.prepare("SELECT id FROM hidden_addresses WHERE account_id = ? AND lower(email) = lower(?)").get(accountId, message.recipient)
      : null;
    const existing = db.prepare("SELECT id FROM inbox_messages WHERE message_uid = ?").get(message.uid);
    if (options.updateOnly && !existing) return false;
    const result = db.prepare(`INSERT INTO inbox_messages
      (id, account_id, address_id, message_uid, subject, sender, code, preview, body_text, body_html, received_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(message_uid) DO UPDATE SET account_id = excluded.account_id,
        address_id = COALESCE(excluded.address_id, inbox_messages.address_id), subject = excluded.subject,
        sender = excluded.sender, code = excluded.code, preview = excluded.preview,
        body_text = excluded.body_text,
        body_html = CASE WHEN excluded.body_html <> '' THEN excluded.body_html ELSE inbox_messages.body_html END,
        received_at = excluded.received_at`)
      .run(randomUUID(), accountId, address?.id || null, message.uid, message.subject || "", message.sender || "",
        message.code || "", message.preview || "", message.bodyText || "", message.bodyHtml || "", message.receivedAt || "",
        new Date().toISOString());
    return !existing && result.changes > 0;
  }

  /** 查询最近同步的邮件。 */
  function listMessages(accountId, limit = 100) {
    return db.prepare(`SELECT m.id, m.subject, m.sender, m.code, m.preview, m.body_text AS bodyText,
      m.received_at AS receivedAt, h.email AS hiddenEmail FROM inbox_messages m
      LEFT JOIN hidden_addresses h ON h.id = m.address_id WHERE m.account_id = ?
      ORDER BY m.received_at DESC LIMIT ?`).all(accountId, limit);
  }

  /** 按 CK 分页查询同步邮件。 */
  function pageMessages(accountId, page = 1, pageSize = 20) {
    const total = Number(db.prepare("SELECT COUNT(*) AS count FROM inbox_messages WHERE account_id = ?").get(accountId).count || 0);
    const rows = db.prepare(`SELECT m.id, m.subject, m.sender, m.code, m.preview, m.body_text AS bodyText,
      m.received_at AS receivedAt, h.email AS hiddenEmail FROM inbox_messages m
      LEFT JOIN hidden_addresses h ON h.id = m.address_id WHERE m.account_id = ?
      ORDER BY m.received_at DESC LIMIT ? OFFSET ?`).all(accountId, pageSize, (page - 1) * pageSize);
    return { rows, total, page, pageSize };
  }

  return {
    listAccounts, getAccount, getAccountInternal, upsertAccount, updateAccountCookie, markAccountExpired, deleteAccount, updateMaildomainHost,
    createJob, createJobWithLabels, allocateLabels, startJob, finishJob, recoverRunningJobs, recoverStaleJobs, hasRunningJob, listJobs, listAllJobs, pageAllJobs,
    countAddresses, createCampaign, findOpenCampaign, getCampaignInternal, listCampaigns, listDueCampaigns,
    stopCampaign, resumeCampaign, updateCampaignLabelPrefix, deleteCampaign, completeCampaign, recordCampaignRun,
    upsertAddresses, listAddresses, pageAddresses, updateAddressState, updateAddressStates,
    getAddress, pageAddressMessages, getMessage, savePublicAccess, revokePublicAccess, getLatestPublicMail,
    getInboxConfigInternal, listInboxConfigs, updateInboxSyncState, resetInboxSyncState, completeInboxHtmlBackfill,
    saveInboxConfig, insertMessage, listMessages, pageMessages
  };
}
