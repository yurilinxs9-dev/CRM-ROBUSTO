'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuthStore } from '@/stores/auth.store';
import { ProfileTab } from './components/ProfileTab';
import { TeamTab } from './components/TeamTab';

const MANAGE_ROLES = ['SUPER_ADMIN', 'GERENTE'];

export default function SettingsPage() {
  const role = useAuthStore((s) => s.user?.role);
  const canManageTeam = role && MANAGE_ROLES.includes(role);

  return (
    <div className="p-6">
      <h2 className="text-xl font-semibold mb-6">Configurações</h2>
      <Tabs defaultValue="profile">
        <TabsList className="mb-6">
          <TabsTrigger value="profile">👤 Meu Perfil</TabsTrigger>
          {canManageTeam && <TabsTrigger value="team">👥 Equipe</TabsTrigger>}
        </TabsList>
        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>
        {canManageTeam && (
          <TabsContent value="team">
            <TeamTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
