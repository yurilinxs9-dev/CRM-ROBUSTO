'use client';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/layout/page-header';
import { useAuthStore } from '@/stores/auth.store';
import { ProfileTab } from './components/ProfileTab';
import { TeamTab } from './components/TeamTab';
import { SectorsTab } from './components/SectorsTab';
import { GeneralTab } from './components/GeneralTab';
import { WebhooksTab } from './components/WebhooksTab';
import { ApiKeysTab } from './components/ApiKeysTab';

const MANAGE_ROLES = ['SUPER_ADMIN', 'GERENTE'];

export default function SettingsPage() {
  const role = useAuthStore((s) => s.user?.role);
  const canManageTeam = role && MANAGE_ROLES.includes(role);

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-6">
        <PageHeader title="Configurações" subtitle="Perfil, equipe, integrações e API" />
      </div>
      <Tabs defaultValue="profile">
        <TabsList className="mb-6">
          <TabsTrigger value="profile">👤 Meu Perfil</TabsTrigger>
          {canManageTeam && <TabsTrigger value="team">👥 Equipe</TabsTrigger>}
          {canManageTeam && <TabsTrigger value="sectors">🏷️ Setores</TabsTrigger>}
          {canManageTeam && <TabsTrigger value="general">⚙️ Geral</TabsTrigger>}
          {canManageTeam && <TabsTrigger value="webhooks">🔗 Webhooks</TabsTrigger>}
          {canManageTeam && <TabsTrigger value="api-keys">🔑 API Keys</TabsTrigger>}
        </TabsList>
        <TabsContent value="profile">
          <ProfileTab />
        </TabsContent>
        {canManageTeam && (
          <TabsContent value="team">
            <TeamTab />
          </TabsContent>
        )}
        {canManageTeam && (
          <TabsContent value="sectors">
            <SectorsTab />
          </TabsContent>
        )}
        {canManageTeam && (
          <TabsContent value="general">
            <GeneralTab />
          </TabsContent>
        )}
        {canManageTeam && (
          <TabsContent value="webhooks">
            <WebhooksTab />
          </TabsContent>
        )}
        {canManageTeam && (
          <TabsContent value="api-keys">
            <ApiKeysTab />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
