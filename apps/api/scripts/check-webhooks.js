#!/usr/bin/env node
/**
 * scripts/check-webhooks.js
 *
 * Verifica estado dos webhooks UazAPI vs URL esperada per-instance.
 * READ-ONLY. Nao modifica nada.
 *
 * Exit codes:
 *   0 = todas instancias vivas MATCH
 *   1 = alguma instancia viva em DRIFT
 *   2 = erro de conexao em alguma chamada
 *   3 = falha de configuracao / inesperado
 */

'use strict';

const crypto = require('node:crypto');
const { PrismaClient } = require('@prisma/client');

const REQUIRED_ENV = ['DATABASE_URL', 'UAZAPI_BASE_URL', 'WEBHOOK_PUBLIC_URL'];
const TIMEOUT_MS = 10000;

function fail(msg) {
  console.error(`FATAL: ${msg}`);
  process.exit(3);
}

function buildExpectedUrl(publicUrl, instanceId, webhookSecret) {
  return `${publicUrl}/api/webhook/uazapi/${instanceId}/${webhookSecret}`;
}

function urlHash(url) {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 8);
}

function classify(currentUrl, expectedUrl, publicUrl) {
  if (!currentUrl) return 'DRIFT_EMPTY';
  if (currentUrl === expectedUrl) return 'MATCH';
  const legacyUrl = `${publicUrl}/api/webhook/uazapi`;
  if (currentUrl === legacyUrl) return 'DRIFT_LEGACY';
  return 'DRIFT_OTHER';
}

async function checkInstance(baseUrl, publicUrl, instance) {
  const cfg = instance.config ?? {};
  const uazapiToken = cfg.uazapi_token;
  if (!uazapiToken) {
    return { nome: instance.nome, status: 'SKIP_NO_TOKEN', url_hash: 'n/a' };
  }
  if (!instance.webhook_secret) {
    return { nome: instance.nome, status: 'SKIP_NO_SECRET', url_hash: 'n/a' };
  }
  const expectedUrl = buildExpectedUrl(
    publicUrl,
    instance.id,
    instance.webhook_secret,
  );

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/webhook`, {
      method: 'GET',
      headers: { token: uazapiToken },
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      return { nome: instance.nome, status: 'ORPHAN', url_hash: 'n/a' };
    }
    if (!res.ok) {
      return {
        nome: instance.nome,
        status: `ERROR_HTTP_${res.status}`,
        url_hash: 'n/a',
      };
    }
    const data = await res.json();
    const currentUrl =
      Array.isArray(data) && data[0]?.url ? data[0].url : null;
    const cls = classify(currentUrl, expectedUrl, publicUrl);
    return {
      nome: instance.nome,
      status: cls,
      url_hash: currentUrl ? urlHash(currentUrl) : 'empty',
    };
  } catch (err) {
    const name = err?.name || 'Error';
    return {
      nome: instance.nome,
      status: `ERROR_${name}`,
      url_hash: 'n/a',
    };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  for (const k of REQUIRED_ENV) {
    if (!process.env[k]) fail(`Missing env var: ${k}`);
  }

  const baseUrl = process.env.UAZAPI_BASE_URL;
  const publicUrl = process.env.WEBHOOK_PUBLIC_URL;

  const prisma = new PrismaClient();
  try {
    const instances = await prisma.whatsappInstance.findMany({
      select: { id: true, nome: true, webhook_secret: true, config: true },
      orderBy: { created_at: 'asc' },
    });

    // Sequencial pra evitar hammering UazAPI. 18 instancias x 10s timeout
    // worst-case = 3min, aceitavel pra verificacao.
    const results = [];
    for (const inst of instances) {
      results.push(await checkInstance(baseUrl, publicUrl, inst));
    }

    console.log(
      'nome'.padEnd(20) + ' | ' + 'status'.padEnd(20) + ' | url_hash',
    );
    console.log('-'.repeat(60));
    for (const r of results) {
      console.log(
        r.nome.padEnd(20) + ' | ' +
        r.status.padEnd(20) + ' | ' +
        r.url_hash,
      );
    }

    const counts = results.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    console.log('\nSUMMARY:');
    for (const [k, v] of Object.entries(counts).sort()) {
      console.log(`  ${k}: ${v}`);
    }

    const hasDrift = results.some((r) => r.status.startsWith('DRIFT'));
    const hasError = results.some((r) => r.status.startsWith('ERROR'));
    let exitCode = 0;
    if (hasError) exitCode = 2;
    else if (hasDrift) exitCode = 1;
    console.log(`\nEXIT_CODE=${exitCode}`);
    process.exit(exitCode);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('UNEXPECTED:', err?.message || err);
  process.exit(3);
});
