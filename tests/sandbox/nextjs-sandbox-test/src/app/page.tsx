'use client'

import { ArrowTopRightOnSquareIcon, TrashIcon } from '@heroicons/react/24/outline';
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

interface User {
  id: number;
  email: string;
}

// Define a minimal type for Blaxel sandboxes
interface BlaxelSandbox {
  metadata: {
    name: string;
  };
  status: 'DELETING' | 'FAILED' | 'DEACTIVATING' | 'DEPLOYING' | 'DEPLOYED';
  // Add other properties if needed from Blaxel
}

export default function Home() {
  const [loading, setLoading] = useState<boolean>(true);
  const [sandboxes, setSandboxes] = useState<BlaxelSandbox[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [newSandboxName, setNewSandboxName] = useState<string>('');
  const [newSandboxDescription, setNewSandboxDescription] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const router = useRouter();
  const firstFetchDone = useRef(false);


  useEffect(() => {
    // Check if user is authenticated
    checkAuth();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Fetch sandboxes when user is authenticated
    if (authChecked && user) {
      fetchSandboxes(true).then(() => { firstFetchDone.current = true; });
      const interval = setInterval(() => {
        fetchSandboxes(false);
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [authChecked, user]);

  async function checkAuth() {
    try {
      const res = await fetch('/api/auth/user');
      if (res.status === 401) {
        // User is not authenticated, redirect to login
        router.push('/login');
        return;
      }

      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
        } else {
          router.push('/login');
        }
      }
    } catch (error) {
      console.error("Auth check error:", error);
      router.push('/login');
    } finally {
      setAuthChecked(true);
    }
  }

  async function logout() {
    try {
      await fetch('/api/auth/logout', {
        method: 'POST',
      });
      router.push('/login');
    } catch (error) {
      console.error("Logout error:", error);
    }
  }

  async function fetchSandboxes(showLoading = false) {
    if (showLoading) setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/sandboxes');

      if (!res.ok) {
        throw new Error('Failed to fetch sandboxes');
      }

      const data = await res.json();
      setSandboxes(data.sandboxes || []);
    } catch (error) {
      console.error("Error fetching sandboxes:", error);
      setError(`Failed to fetch sandboxes: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  async function createSandbox(e: React.FormEvent) {
    e.preventDefault();

    if (!newSandboxName.trim()) {
      setError('App name is required');
      return;
    }

    setIsCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/sandboxes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: newSandboxName.trim(),
        }),
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to create sandbox');
      }

      // Reset form fields
      setNewSandboxName('');
      setNewSandboxDescription('');

      // Refresh sandbox list
      await fetchSandboxes();
    } catch (error) {
      console.error("Error creating sandbox:", error);
      setError(`Failed to create sandbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setIsCreating(false);
    }
  }

  async function deleteSandbox(name: string) {
    if (!confirm('Are you sure you want to delete this sandbox?')) {
      return;
    }

    setError(null);

    try {
      const res = await fetch(`/api/sandboxes/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.error || 'Failed to delete sandbox');
      }

      // Refresh sandbox list
      await fetchSandboxes();
    } catch (error) {
      console.error("Error deleting sandbox:", error);
      setError(`Failed to delete sandbox: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  function openSandbox(name: string) {
    router.push(`/sandbox/${encodeURIComponent(name)}`);
  }

  return (
    <main className="min-h-screen p-8" style={{ background: 'var(--background)', color: 'var(--foreground)' }}>
      <div className="max-w-5xl mx-auto shadow-md rounded-lg p-6" style={{ background: 'var(--secondary)', color: 'var(--secondary-foreground)', border: '1px solid var(--border)' }}>
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-2xl font-bold">My Apps</h1>
          <div className="flex items-center gap-4">
            {user && (
              <span style={{ color: 'var(--muted-foreground)' }}>
                {user.email}
              </span>
            )}
            <button
              onClick={logout}
              className="px-4 py-2 rounded hover:opacity-90"
              style={{ background: 'var(--muted)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
            >
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="px-4 py-3 rounded mb-6" style={{ background: 'var(--error)', color: 'var(--primary-foreground)', border: '1px solid var(--border)' }}>
            {error}
          </div>
        )}

        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Create New App</h2>
          <form onSubmit={createSandbox} className="p-4 rounded border" style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                  Name*
                </label>
                <input
                  type="text"
                  value={newSandboxName}
                  onChange={(e) => setNewSandboxName(e.target.value)}
                  className="w-full px-3 py-2 rounded focus:outline-none focus:ring-2"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  placeholder="My Project"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1" style={{ color: 'var(--muted-foreground)' }}>
                  Description
                </label>
                <input
                  type="text"
                  value={newSandboxDescription}
                  onChange={(e) => setNewSandboxDescription(e.target.value)}
                  className="w-full px-3 py-2 rounded focus:outline-none focus:ring-2"
                  style={{ background: 'var(--background)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
                  placeholder="Optional description"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={isCreating || !newSandboxName.trim()}
                className="px-4 py-2 rounded"
                style={{
                  background: isCreating || !newSandboxName.trim() ? 'var(--primary)' : 'var(--primary)',
                  color: 'var(--primary-foreground)',
                  opacity: isCreating || !newSandboxName.trim() ? 0.6 : 1,
                  cursor: isCreating || !newSandboxName.trim() ? 'not-allowed' : 'pointer',
                }}
              >
                {isCreating ? 'Creating...' : 'Create App'}
              </button>
            </div>
          </form>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">Your Apps</h2>

          {loading ? (
            <div className="text-center py-8">
              <div className="inline-block w-8 h-8 border-4 rounded-full animate-spin" style={{ borderColor: 'var(--border)', borderTopColor: 'var(--primary)' }}></div>
              <p className="mt-2" style={{ color: 'var(--muted-foreground)' }}>Loading apps...</p>
            </div>
          ) : sandboxes.length === 0 ? (
            <div className="text-center py-8 rounded border" style={{ background: 'var(--muted)', border: '1px solid var(--border)' }}>
              <p style={{ color: 'var(--muted-foreground)' }}>You don&apos;t have any apps yet. Create one above!</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border rounded" style={{ border: '1px solid var(--border)' }}>
                <thead style={{ background: 'var(--muted)' }}>
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Status</th>
                    <th className="px-6 py-3 text-right text-xs font-medium uppercase tracking-wider" style={{ color: 'var(--muted-foreground)' }}>Actions</th>
                  </tr>
                </thead>
                <tbody style={{ background: 'var(--secondary)' }}>
                  {sandboxes.map((sandbox) => (
                    <tr key={sandbox.metadata?.name} className="hover:opacity-90" style={{ borderBottom: '1px solid var(--border)' }}>
                      <td className="px-6 py-4 whitespace-nowrap">{sandbox.metadata?.name}</td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <span
                          className={`px-2 py-1 rounded text-xs font-semibold ${
                            sandbox.status === 'DEPLOYED' ? 'bg-green-100 text-green-800' :
                            sandbox.status === 'DEPLOYING' ? 'bg-yellow-100 text-yellow-800' :
                            sandbox.status === 'DELETING' ? 'bg-red-100 text-red-800' :
                            sandbox.status === 'DEACTIVATING' ? 'bg-orange-100 text-orange-800' :
                            sandbox.status === 'FAILED' ? 'bg-gray-200 text-gray-800' :
                            ''
                          }`}
                        >
                          {sandbox.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => sandbox.status === 'DEPLOYED' && openSandbox(sandbox.metadata?.name)}
                          className={`icon-btn mr-3 ${sandbox.status !== 'DEPLOYED' ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                          title={sandbox.status === 'DEPLOYED' ? 'Open' : `Cannot open: ${sandbox.status}`}
                          disabled={sandbox.status !== 'DEPLOYED'}
                        >
                          <ArrowTopRightOnSquareIcon className="h-5 w-5" />
                        </button>
                        <button
                          className="icon-btn"
                          title="Delete"
                          onClick={() => deleteSandbox(sandbox.metadata?.name)}
                        >
                          <TrashIcon className="h-5 w-5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
