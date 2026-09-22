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
<body style="margin:0;padding:0;background:#eef2ef;font-family:Arial,Helvetica,sans-serif;color:#172620">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Um novo acesso, com a segurança de sempre. Redefina sua senha no CRM PRO.</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#eef2ef"><tr><td align="center" style="padding:28px 12px">
<!--[if mso]><table role="presentation" width="600"><tr><td><![endif]-->
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border-radius:20px;overflow:hidden;border:1px solid #dfe7e2">
<tr><td bgcolor="#0b1511" style="padding:26px 28px 22px"><table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td style="font-size:23px;font-weight:700;letter-spacing:-1px;color:#ffffff">CRM <span style="color:#5ce3ac">PRO</span></td><td align="right" style="font-size:10px;letter-spacing:1.5px;color:#a9beb3">ACESSO SEGURO</td></tr></table></td></tr>
<tr><td bgcolor="#0b1511"><img src="https://crm-robusto-nine.vercel.app/email/crm-pro-security-v2.jpg" width="600" alt="Cadeado 3D em vidro verde-esmeralda: segurança para sua conta CRM PRO." style="display:block;width:100%;max-width:600px;height:auto;border:0;color:#b4d2c2;font-size:14px"></td></tr>
<tr><td style="padding:32px 28px 30px">
<p style="margin:0 0 12px;color:#08734f;font-size:10px;font-weight:700;letter-spacing:2px">RECUPERAÇÃO DE CONTA</p>
<h1 style="margin:0 0 16px;font-size:32px;line-height:1.15;letter-spacing:-1px;font-weight:700;color:#14291f">Seu próximo acesso<br>começa aqui.</h1>
<p style="margin:0 0 24px;font-size:15px;line-height:1.7;color:#5b6c63">Recebemos seu pedido para redefinir a senha.<br>Escolha uma nova senha para voltar ao CRM PRO.</p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" bgcolor="#08734f" style="border-radius:9px;mso-padding-alt:18px 20px"><a href="${url}" style="display:block;padding:18px 20px;font-size:15px;font-weight:700;line-height:20px;color:#ffffff;text-decoration:none">Redefinir minha senha &nbsp; &#8594;</a></td></tr></table>
<p style="margin:14px 0 26px;text-align:center;font-size:12px;color:#6a7a71">Link válido por <strong style="color:#324d3f">1 hora</strong></p>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td bgcolor="#f3f6f3" style="padding:16px 18px;border-radius:9px;font-size:12px;line-height:1.7;color:#65766c"><strong style="color:#324d3f">Não foi você?</strong><br>Pode ignorar esta mensagem. Sua senha continua a mesma. Para sua segurança, não compartilhe este link.</td></tr></table>
<p style="margin:24px 0 8px;font-size:11px;line-height:1.6;color:#758179">Se o botão não abrir, copie e cole o endereço no navegador:</p>
<p style="margin:0;font-size:11px;line-height:1.7;word-break:break-all;overflow-wrap:anywhere"><a href="${url}" style="color:#08734f;text-decoration:underline;word-break:break-all">${url}</a></p>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
<p style="margin:22px 0 6px;font-size:12px;font-weight:700;letter-spacing:1px;color:#456353">CRM PRO</p><p style="margin:0;font-size:11px;line-height:1.6;color:#7b8a81">Gestão simples. Conexões que crescem.<br>Mensagem automática. Não responda a este e-mail.</p>
</td></tr></table></body></html>`,
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
