'use client';

import {
  User,
  Users,
  Tag,
  Settings2,
  ListChecks,
  Copy,
  Webhook,
  KeyRound,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/layout/page-header';
import { useAuthStore } from '@/stores/auth.store';
import { ProfileTab } from './components/ProfileTab';
import { TeamTab } from './components/TeamTab';
import { SectorsTab } from './components/SectorsTab';
import { GeneralTab } from './components/GeneralTab';
import { WebhooksTab } from './components/WebhooksTab';
import { ApiKeysTab } from './components/ApiKeysTab';
import { CustomFieldsTab } from './components/CustomFieldsTab';
import { DuplicatesTab } from './components/DuplicatesTab';

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
          <TabsTrigger value="profile" className="gap-1.5">
            <User size={14} /> Meu Perfil
          </TabsTrigger>
          {canManageTeam && (
            <TabsTrigger value="team" className="gap-1.5">
              <Users size={14} /> Equipe
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="sectors" className="gap-1.5">
              <Tag size={14} /> Setores
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="general" className="gap-1.5">
              <Settings2 size={14} /> Geral
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="custom-fields" className="gap-1.5">
              <ListChecks size={14} /> Campos
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="duplicates" className="gap-1.5">
              <Copy size={14} /> Duplicados
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="webhooks" className="gap-1.5">
              <Webhook size={14} /> Webhooks
            </TabsTrigger>
          )}
          {canManageTeam && (
            <TabsTrigger value="api-keys" className="gap-1.5">
              <KeyRound size={14} /> API Keys
            </TabsTrigger>
          )}
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
          <TabsContent value="custom-fields">
            <CustomFieldsTab />
          </TabsContent>
        )}
        {canManageTeam && (
          <TabsContent value="duplicates">
            <DuplicatesTab />
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
