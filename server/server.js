const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = process.env.PORT || 5501;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'priznanie-2026';

const CAMPAIGNS_FILE = path.join(__dirname, 'data', 'campaigns.json');
const CANDIDATES_FILE = path.join(__dirname, 'data', 'candidates.json');
const PROJECT_ROOT = path.join(__dirname, '..');

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveJson(file, list) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list, null, 2), 'utf8');
}

let campaigns = loadJson(CAMPAIGNS_FILE);
let candidates = loadJson(CANDIDATES_FILE);

function findCampaign(id) {
  return campaigns.find(function (c) { return c.id === id; });
}

function normUnit(unit) {
  return String(unit || '').trim().toLowerCase();
}

function csvEscape(value) {
  const s = String(value == null ? '' : value);
  if (/[",\n;]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---- Admin auth ----
app.post('/api/admin/login', function (req, res) {
  const password = (req.body && req.body.password) || '';
  if (password === ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false, error: 'Неверный пароль' });
  }
});

// ---- Campaigns ----
app.get('/api/campaigns', function (req, res) {
  res.json(campaigns.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }));
});

app.post('/api/campaigns', function (req, res) {
  const b = req.body || {};
  const required = ['title', 'deadline'];
  for (const field of required) {
    if (!b[field] || !String(b[field]).trim()) {
      return res.status(400).json({ error: 'Поле "' + field + '" обязательно' });
    }
  }
  const item = {
    id: 'camp_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    title: b.title,
    occasion: b.occasion || '',
    criteria: b.criteria || '',
    quotaPerUnit: Number(b.quotaPerUnit) > 0 ? Number(b.quotaPerUnit) : 0,
    deadline: b.deadline,
    status: 'open',
    createdAt: new Date().toISOString()
  };
  campaigns.push(item);
  saveJson(CAMPAIGNS_FILE, campaigns);
  res.status(201).json(item);
});

app.patch('/api/campaigns/:id', function (req, res) {
  const item = findCampaign(req.params.id);
  if (!item) return res.status(404).json({ error: 'Кампания не найдена' });
  const b = req.body || {};
  const editable = ['title', 'occasion', 'criteria', 'quotaPerUnit', 'deadline', 'status'];
  for (const field of editable) {
    if (b[field] !== undefined) {
      item[field] = field === 'quotaPerUnit' ? (Number(b[field]) > 0 ? Number(b[field]) : 0) : b[field];
    }
  }
  saveJson(CAMPAIGNS_FILE, campaigns);
  res.json(item);
});

// ---- Quota lookup (used by the submission form to show remaining slots) ----
app.get('/api/campaigns/:id/quota', function (req, res) {
  const item = findCampaign(req.params.id);
  if (!item) return res.status(404).json({ error: 'Кампания не найдена' });
  const unit = normUnit(req.query.unit);
  const used = candidates.filter(function (c) { return c.campaignId === item.id && normUnit(c.unit) === unit; }).length;
  const quota = item.quotaPerUnit || 0;
  res.json({ quota: quota, used: used, remaining: quota > 0 ? Math.max(0, quota - used) : null });
});

// ---- Candidates ----
app.get('/api/campaigns/:id/candidates', function (req, res) {
  const item = findCampaign(req.params.id);
  if (!item) return res.status(404).json({ error: 'Кампания не найдена' });
  const list = candidates.filter(function (c) { return c.campaignId === item.id; });
  res.json(list.slice().sort(function (a, b) { return b.createdAt.localeCompare(a.createdAt); }));
});

app.post('/api/campaigns/:id/candidates', function (req, res) {
  const campaign = findCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
  if (campaign.status !== 'open') return res.status(400).json({ error: 'Кампания закрыта для подачи кандидатов' });

  const b = req.body || {};
  const submittedBy = b.submittedBy || {};
  if (!submittedBy.name || !String(submittedBy.name).trim()) {
    return res.status(400).json({ error: 'Укажите ФИО подающего руководителя' });
  }
  if (!submittedBy.unit || !String(submittedBy.unit).trim()) {
    return res.status(400).json({ error: 'Укажите структурное звено (СЗ)' });
  }
  const list = Array.isArray(b.candidates) ? b.candidates : [];
  if (list.length === 0) {
    return res.status(400).json({ error: 'Добавьте хотя бы одного кандидата' });
  }

  const requiredFields = ['fullName', 'position', 'region', 'justification'];
  for (const cand of list) {
    for (const field of requiredFields) {
      if (!cand[field] || !String(cand[field]).trim()) {
        return res.status(400).json({ error: 'У кандидата "' + (cand.fullName || '?') + '" не заполнено обязательное поле "' + field + '"' });
      }
    }
    if (cand.hadPreviousAward === 'yes' && (!cand.previousAwardTitle || !String(cand.previousAwardTitle).trim())) {
      return res.status(400).json({ error: 'У кандидата "' + cand.fullName + '" укажите название предыдущей награды' });
    }
  }

  const unitKey = normUnit(submittedBy.unit);
  const quota = campaign.quotaPerUnit || 0;
  if (quota > 0) {
    const already = candidates.filter(function (c) { return c.campaignId === campaign.id && normUnit(c.unit) === unitKey; }).length;
    if (already + list.length > quota) {
      return res.status(400).json({
        error: 'Превышена квота для вашего СЗ: доступно ' + Math.max(0, quota - already) + ' из ' + quota + ' мест, а вы пытаетесь подать ' + list.length
      });
    }
  }

  const created = list.map(function (cand) {
    return {
      id: 'cand_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
      campaignId: campaign.id,
      fullName: cand.fullName,
      position: cand.position,
      region: cand.region,
      unit: submittedBy.unit,
      tenure: cand.tenure || '',
      hadPreviousAward: cand.hadPreviousAward === 'yes' ? 'yes' : 'no',
      previousAwardTitle: cand.hadPreviousAward === 'yes' ? cand.previousAwardTitle : '',
      justification: cand.justification,
      submittedBy: {
        name: submittedBy.name,
        position: submittedBy.position || '',
        unit: submittedBy.unit,
        region: submittedBy.region || '',
        phone: submittedBy.phone || ''
      },
      status: 'submitted',
      createdAt: new Date().toISOString()
    };
  });
  candidates = candidates.concat(created);
  saveJson(CANDIDATES_FILE, candidates);
  res.status(201).json(created);
});

// ---- CSV export for the awards committee ----
app.get('/api/campaigns/:id/export', function (req, res) {
  const campaign = findCampaign(req.params.id);
  if (!campaign) return res.status(404).json({ error: 'Кампания не найдена' });
  const list = candidates
    .filter(function (c) { return c.campaignId === campaign.id; })
    .sort(function (a, b) { return a.unit.localeCompare(b.unit, 'ru') || a.fullName.localeCompare(b.fullName, 'ru'); });

  const header = ['Награда', 'СЗ / подразделение', 'Регион', 'ФИО кандидата', 'Должность', 'Стаж работы', 'Ранее награждался', 'Название предыдущей награды', 'Обоснование', 'Подал(а)', 'Дата подачи'];
  const rows = list.map(function (c) {
    return [
      campaign.title,
      c.unit,
      c.region,
      c.fullName,
      c.position,
      c.tenure,
      c.hadPreviousAward === 'yes' ? 'Да' : 'Нет',
      c.previousAwardTitle,
      c.justification,
      c.submittedBy.name + (c.submittedBy.position ? ' (' + c.submittedBy.position + ')' : ''),
      new Date(c.createdAt).toLocaleDateString('ru-RU')
    ].map(csvEscape).join(';');
  });
  const csv = '﻿' + header.map(csvEscape).join(';') + '\n' + rows.join('\n');

  const filename = 'candidates_' + campaign.id + '.csv';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
  res.send(csv);
});

// ---- Static frontend ----
app.use(express.static(PROJECT_ROOT));

app.listen(PORT, function () {
  console.log('Priznanie award portal server running on http://localhost:' + PORT);
});
