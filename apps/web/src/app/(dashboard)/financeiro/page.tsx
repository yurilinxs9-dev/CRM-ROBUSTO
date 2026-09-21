'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { LockKeyhole, ShieldCheck } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { canAccessFinance, financeError, financeRequest } from '@/lib/finance';
import { Button } from '@/components/ui/button';
import { FinanceWorkspace } from '@/components/finance/finance-workspace';
const input = 'w-full rounded-md border bg-background px-3 py-2 text-sm';
export default function FinancePage() { const user = useAuthStore(s => s.user); const impersonating = useAuthStore(s => s.impersonating); if (impersonating || !canAccessFinance(user?.tenantId, user?.id))
    return <main className="p-8"><h1 className="text-xl font-semibold">Área indisponível</h1><p className="mt-2 text-muted-foreground">Este usuário não possui acesso ao financeiro.</p></main>; return <FinanceAccess key={user!.id + user!.tenantId}/>; }
function FinanceAccess() {
    const [token, setToken] = useState('');
    const [expiry, setExpiry] = useState('');
    const [configured, setConfigured] = useState<boolean | null>(null);
    const [reset, setReset] = useState(false);
    const [password, setPassword] = useState('');
    const [crmPassword, setCrmPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    useEffect(() => { let live = true; financeRequest<{
        configured: boolean;
    }>('access').then(r => { if (live)
        setConfigured(r.configured); }).catch(e => { if (live)
        setError(financeError(e)); }); return () => { live = false; }; }, []);
    useEffect(() => { if (!token || !expiry)
        return; const timer = setTimeout(() => { setToken(''); setError('Sessão financeira expirada. Entre novamente.'); }, Math.max(0, new Date(expiry).valueOf() - Date.now())); return () => clearTimeout(timer); }, [token, expiry]);
    const setup = configured === false || reset;
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (busy)
            return;
        setBusy(true);
        setError('');
        try {
            if (setup) {
                if (password !== confirm)
                    throw new Error('As senhas financeiras não coincidem.');
                await financeRequest('access/setup', undefined, 'POST', { currentPassword: crmPassword, newPassword: password });
                setConfigured(true);
                setReset(false);
                setCrmPassword('');
                setConfirm('');
            }
            const session = await financeRequest<{
                token: string;
                expires_at: string;
            }>('access/login', undefined, 'POST', { password });
            setToken(session.token);
            setExpiry(session.expires_at);
            setPassword('');
        }
        catch (e) {
            setError(financeError(e));
        }
        finally {
            setBusy(false);
        }
    }
    async function lock() { const old = token; setToken(''); setPassword(''); try {
        await financeRequest('access/logout', old, 'POST');
    }
    catch {
        setError('Financeiro bloqueado neste dispositivo. A sessão anterior expirará automaticamente.');
    } }
    if (token)
        return <FinanceWorkspace token={token} lock={lock} expired={() => { setToken(''); setError('Desbloqueie o financeiro novamente.'); }}/>;
    return <main className="mx-auto max-w-lg p-5 py-12"><div className="mb-6 flex h-12 w-12 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600"><LockKeyhole /></div><h1 className="text-2xl font-semibold">Financeiro da Paloma</h1><p className="mt-2 text-sm text-muted-foreground">Acesso exclusivo com uma senha própria. Sua sessão do CRM continua separada.</p><section className="mt-7 rounded-xl border bg-card p-6">{configured === null ? <p role="status">{error ? 'Não foi possível verificar o acesso. Atualize a página.' : 'Verificando acesso…'}</p> : <form onSubmit={submit} className="space-y-4"><h2 className="font-semibold">{setup ? 'Definir senha financeira' : 'Desbloquear financeiro'}</h2>{setup && <label className="block space-y-1 text-sm"><span>Sua senha atual do CRM</span><input required type="password" autoComplete="current-password" className={input} value={crmPassword} onChange={e => setCrmPassword(e.target.value)}/></label>}<label className="block space-y-1 text-sm"><span>{setup ? 'Nova senha financeira' : 'Senha financeira'}</span><input required type="password" minLength={setup ? 8 : undefined} maxLength={72} autoComplete={setup ? 'new-password' : 'current-password'} className={input} value={password} onChange={e => setPassword(e.target.value)}/></label>{setup && <label className="block space-y-1 text-sm"><span>Confirmar senha financeira</span><input required type="password" autoComplete="new-password" className={input} value={confirm} onChange={e => setConfirm(e.target.value)}/></label>}<Button disabled={busy} className="w-full">{busy ? 'Aguarde…' : setup ? 'Definir senha e entrar' : 'Entrar no financeiro'}</Button>{configured && <Button type="button" variant="ghost" className="w-full" disabled={busy} onClick={() => { setReset(!reset); setPassword(''); setConfirm(''); setError(''); }}>{reset ? 'Voltar ao login financeiro' : 'Esqueci / quero alterar a senha financeira'}</Button>}</form>}{error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}</section><p className="mt-4 flex gap-2 text-xs text-muted-foreground"><ShieldCheck className="h-4 w-4 shrink-0"/>A sessão expira em 2 horas. Ao atualizar ou sair desta página, será necessário desbloquear novamente.</p></main>;
}
