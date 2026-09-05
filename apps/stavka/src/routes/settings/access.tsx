import { Banner } from "@cloudflare/kumo/components/banner";
import { LayerCard } from "@cloudflare/kumo/components/layer-card";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readOrganizationUsers } from "../../account-api";

export const Route = createFileRoute("/settings/access")({ component: AccessSettings });
function AccessSettings() {
  const users = useQuery({
    queryKey: ["stavka-organization-users"],
    queryFn: readOrganizationUsers,
  });
  return (
    <div className="stavka-pane space-y-4">
      <header className="stavka-page-heading">
        <div>
          <h1>Organization access</h1>
          <p>
            Cloudflare Access controls sign-in. These are the current organization memberships;
            provider credentials remain private to their owner.
          </p>
        </div>
      </header>
      {users.error ? (
        <Banner variant="error" title="Memberships unavailable" description={users.error.message} />
      ) : null}
      {users.isPending ? <p>Loading memberships…</p> : null}
      {users.data ? (
        <LayerCard className="overflow-x-auto p-4">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-kumo-hairline text-xs text-kumo-subtle">
                <th className="pb-3 font-medium">Name</th>
                <th className="pb-3 font-medium">Role</th>
              </tr>
            </thead>
            <tbody>
              {users.data.map(({ user, membership }) => (
                <tr key={user.id} className="border-b border-kumo-hairline last:border-0">
                  <td className="py-4">{user.displayName}</td>
                  <td className="capitalize">{membership.role}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </LayerCard>
      ) : null}
    </div>
  );
}
