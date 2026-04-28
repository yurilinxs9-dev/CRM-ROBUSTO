'use client';

import { useState, useRef, useEffect } from 'react';
import { Camera, KeyRound, Save } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

function getInitials(name: string) {
  return name.split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

export function ProfileTab() {
  const user = useAuthStore((s) => s.user);
  const updateUser = useAuthStore((s) => s.updateUser);

  const [nome, setNome] = useState('');
  const [titulo, setTitulo] = useState('');
  const [especialidade, setEspecialidade] = useState('');
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [isPending, setIsPending] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [pwPending, setPwPending] = useState(false);

  useEffect(() => {
    api
      .get<{ user: { nome: string; titulo?: string | null; especialidade?: string | null } }>('/api/auth/me')
      .then((res) => {
        const u = res.data.user;
        setNome(u.nome ?? '');
        setTitulo(u.titulo ?? '');
        setEspecialidade(u.especialidade ?? '');
      })
      .catch(() => setNome(user?.nome ?? ''));
  }, [user?.nome]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAvatarFile(file);
    setAvatarPreview(URL.createObjectURL(file));
  };

  const handleSave = async () => {
    if (!nome.trim()) return;
    setIsPending(true);
    try {
      let newAvatarUrl: string | undefined;
      if (avatarFile) {
        try {
          const form = new FormData();
          form.append('avatar', avatarFile);
          const res = await api.post<{ url: string }>('/api/users/me/avatar', form, {
            headers: { 'Content-Type': 'multipart/form-data' },
          });
          newAvatarUrl = res.data.url;
        } catch {
          toast.error('Erro ao enviar foto. Os outros dados serão salvos.');
        }
      }
      const res = await api.patch<{ nome: string }>('/api/users/me', {
        nome: nome.trim(),
        titulo: titulo.trim() || null,
        especialidade: especialidade.trim() || null,
      });
      updateUser({ nome: res.data.nome, ...(newAvatarUrl ? { avatar_url: newAvatarUrl } : {}) });
      toast.success('Perfil atualizado!');
      setAvatarFile(null);
    } catch {
      toast.error('Erro ao salvar perfil.');
    } finally {
      setIsPending(false);
    }
  };

  const handleChangePassword = async () => {
    if (newPassword.length < 8) {
      toast.error('Nova senha precisa ter ao menos 8 caracteres');
      return;
    }
    if (newPassword !== confirmPassword) {
      toast.error('Confirmação não bate com a nova senha');
      return;
    }
    setPwPending(true);
    try {
      await api.patch('/api/users/me/password', { currentPassword, newPassword });
      toast.success('Senha alterada com sucesso');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(msg || 'Erro ao alterar senha');
    } finally {
      setPwPending(false);
    }
  };

  const displayAvatar = avatarPreview ?? user?.avatar_url ?? null;

  return (
    <div className="max-w-lg space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar className="h-20 w-20">
            {displayAvatar && <AvatarImage src={displayAvatar} alt={nome} />}
            <AvatarFallback className="text-xl font-semibold">
              {getInitials(nome || user?.nome || '?')}
            </AvatarFallback>
          </Avatar>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow hover:bg-primary/90"
            title="Alterar foto"
          >
            <Camera className="h-3.5 w-3.5" />
          </button>
        </div>
        <div>
          <p className="text-sm font-medium">{nome || user?.nome}</p>
          <p className="text-xs text-muted-foreground">{user?.email}</p>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            className="text-xs text-primary hover:underline mt-0.5 block"
          >
            Alterar foto
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="hidden"
          onChange={handleFileChange}
        />
      </div>

      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="nome">Nome</Label>
          <Input id="nome" value={nome} onChange={(e) => setNome(e.target.value)} placeholder="Seu nome completo" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="titulo">Título <span className="text-muted-foreground text-xs">(opcional)</span></Label>
          <Input id="titulo" value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Dr., Dra., Prof." />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="especialidade">Especialidade <span className="text-muted-foreground text-xs">(opcional)</span></Label>
          <Input id="especialidade" value={especialidade} onChange={(e) => setEspecialidade(e.target.value)} placeholder="Direito Trabalhista..." />
        </div>
        <div className="space-y-1.5">
          <Label>Email</Label>
          <Input value={user?.email ?? ''} readOnly disabled className="opacity-60 cursor-not-allowed" />
        </div>
        <Button onClick={handleSave} disabled={isPending || !nome.trim()} className="w-full">
          <Save className="h-4 w-4 mr-2" />
          {isPending ? 'Salvando...' : 'Salvar'}
        </Button>
      </div>

      <div className="border-t border-border pt-6 space-y-4">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-medium">Alterar senha</h3>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="currentPassword">Senha atual</Label>
          <Input
            id="currentPassword"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="newPassword">Nova senha <span className="text-muted-foreground text-xs">(mín. 8 caracteres)</span></Label>
          <Input
            id="newPassword"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirmPassword">Confirmar nova senha</Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="••••••••"
          />
        </div>
        <Button
          onClick={handleChangePassword}
          disabled={pwPending || !currentPassword || !newPassword || !confirmPassword}
          variant="outline"
          className="w-full"
        >
          <KeyRound className="h-4 w-4 mr-2" />
          {pwPending ? 'Alterando...' : 'Alterar senha'}
        </Button>
      </div>
    </div>
  );
}
