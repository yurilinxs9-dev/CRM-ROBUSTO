function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function passwordResetEmail(resetUrl: string) {
  const url = escapeHtml(resetUrl);
  return {
    subject: 'Redefina sua senha | CRM PRO',
    text: `Recebemos uma solicitação para redefinir sua senha no CRM PRO.\n\nEscolha uma nova senha: ${resetUrl}\n\nEste link é válido por 1 hora. Se você não solicitou a alteração, ignore este e-mail. Sua senha permanecerá a mesma. Não compartilhe este link.`,
    html: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Redefina sua senha | CRM PRO</title></head>
<body style="margin:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;color:#102438">
<div style="display:none;max-height:0;overflow:hidden">Redefina sua senha com segurança. Seu link é válido por 1 hora.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:40px 16px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:580px;background:#fff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden">
<tr><td style="padding:30px 32px;background:#102438;border-bottom:4px solid #10b981"><span style="font-size:26px;font-weight:bold;color:#fff">CRM <span style="color:#34d399">PRO</span></span><p style="margin:8px 0 0;font-size:13px;color:#cbd5e1">Conexões que geram oportunidades.</p></td></tr>
<tr><td style="padding:36px 32px"><p style="margin:0 0 12px;font-size:11px;font-weight:bold;letter-spacing:2px;color:#047857">SUA CONTA</p>
<h1 style="margin:0 0 20px;font-size:28px;line-height:1.3">Vamos renovar sua senha?</h1>
<p style="margin:0 0 28px;font-size:16px;line-height:1.7;color:#475569">Recebemos uma solicitação para redefinir a senha da sua conta. Clique no botão abaixo para escolher uma nova senha e continuar acessando o CRM PRO.</p>
<table role="presentation" cellspacing="0" cellpadding="0"><tr><td bgcolor="#047857" style="border-radius:8px"><a href="${url}" style="display:inline-block;padding:17px 26px;color:#fff;font-size:16px;font-weight:bold;text-decoration:none">Redefinir minha senha</a></td></tr></table>
<p style="margin:24px 0 0;font-size:14px;line-height:1.7;color:#475569"><strong>Este link é válido por 1 hora.</strong><br>Se você não solicitou essa alteração, pode ignorar este e-mail. Sua senha permanecerá a mesma.</p>
<hr style="border:0;border-top:1px solid #e2e8f0;margin:28px 0"><p style="font-size:12px;line-height:1.6;color:#64748b">Se o botão não funcionar, copie e cole este link no navegador:</p>
<p style="font-size:12px;line-height:1.6;word-break:break-all;overflow-wrap:anywhere"><a href="${url}" style="color:#047857">${url}</a></p></td></tr>
<tr><td style="padding:22px 32px;background:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.7;color:#64748b"><strong>CRM PRO</strong><br>Este é um e-mail automático. Não responda a esta mensagem.<br>Para sua segurança, não compartilhe este link.</td></tr>
</table></td></tr></table></body></html>`,
  };
}

export async function sendPasswordResetEmail(apiKey: string, from: string, to: string, resetUrl: string, tokenHash: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `password-reset/${tokenHash}` },
    body: JSON.stringify({ from, to: [to], ...passwordResetEmail(resetUrl) }),
    signal: AbortSignal.timeout(10000),
  });
  // Never include the provider body, recipient, credential or reset URL in errors/logs.
  if (!response.ok) throw new Error(`Resend HTTP ${response.status}`);
}
