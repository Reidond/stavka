import { Banner } from "@cloudflare/kumo/components/banner";
import { Empty } from "@cloudflare/kumo/components/empty";
import { Collapsible } from "@cloudflare/kumo/components/collapsible";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { readAccountSession, readOrganizationUsers } from "../../account-api";
import { accountSessionQueryKey } from "../../components/account-gate";
import { CheckedAt, Loading, Refresh, titleCase } from "../../components/page-state";
import { PageActions } from "../../components/shell";
export const Route = createFileRoute("/settings/access")({ component: AccessSettings });
function AccessSettings() {
  const users = useQuery({
    queryKey: ["stavka-organization-users"],
    queryFn: readOrganizationUsers,
    retry: false,
  });
  const session = useQuery({
    queryKey: accountSessionQueryKey,
    queryFn: readAccountSession,
    staleTime: 30_000,
  });
  const currentId = session.data?.status === "active" ? session.data.user.id : undefined;
  return (
    <div className="stavka-pane space-y-4">
      <PageActions>
        <CheckedAt timestamp={users.dataUpdatedAt} />
        <Refresh loading={users.isFetching} onClick={() => void users.refetch()} />
      </PageActions>
      <p className="text-sm text-kumo-subtle">
        Cloudflare Access controls sign-in; membership determines organization access.
      </p>
      {users.error ? (
        <Banner variant="error" title="Memberships unavailable" description={users.error.message} />
      ) : (
        <section className="stavka-panel">
          <div className="table-scroll">
            <table className="operations-table access-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th className="access-email">Email</th>
                  <th>Role</th>
                  <th>Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.isPending ? (
                  <tr>
                    <td colSpan={4}>
                      <Loading label="Loading memberships" />
                    </td>
                  </tr>
                ) : (
                  users.data.map(({ user, membership }) => (
                    <tr key={user.id} data-current={user.id === currentId}>
                      <td>
                        {user.displayName}
                        {user.id === currentId ? (
                          <span className="ml-2 text-xs text-kumo-subtle">You</span>
                        ) : null}
                        <Collapsible.Root className="access-mobile-details">
                          <Collapsible.DefaultTrigger>Email</Collapsible.DefaultTrigger>
                          <Collapsible.Panel className="break-all">
                            {user.email ?? "Not provided"}
                          </Collapsible.Panel>
                        </Collapsible.Root>
                      </td>
                      <td className="access-email">{user.email ?? "Not provided"}</td>
                      <td>{titleCase(membership.role)}</td>
                      <td>
                        <time title={new Date(membership.joinedAt).toLocaleString()}>
                          {new Date(membership.joinedAt).toLocaleDateString()}
                        </time>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {users.data?.length === 0 ? <Empty size="sm" title="No memberships available" /> : null}
        </section>
      )}
    </div>
  );
}
