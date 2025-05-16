'use client'

import { Sandbox } from "@/lib/db/schema";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

interface User {
  id: number;
  email: string;
}

export default function Home() {
  const [loading, setLoading] = useState<boolean>(true);
  const [sandboxes, setSandboxes] = useState<Sandbox[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authChecked, setAuthChecked] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [newSandboxName, setNewSandboxName] = useState<string>('');
  const [newSandboxDescription, setNewSandboxDescription] = useState<string>('');
  const [isCreating, setIsCreating] = useState<boolean>(false);
  const router = useRouter();

  useEffect(() => {
    // Check if user is authenticated
    checkAuth();
  }, []);

  useEffect(() => {
    // Fetch sandboxes when user is authenticated
    if (authChecked && user) {
      fetchSandboxes();
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

  async function fetchSandboxes() {
    setLoading(true);
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
      setLoading(false);
    }
  }

  async function createSandbox(e: React.FormEvent) {
    e.preventDefault();

    if (!newSandboxName.trim()) {
      setError('Sandbox name is required');
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
          description: newSandboxDescription.trim(),
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

  async function deleteSandbox(id: number) {
    if (!confirm('Are you sure you want to delete this sandbox?')) {
      return;
    }

    setError(null);

    try {
      const res = await fetch(`/api/sandboxes?id=${id}`, {
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

  function openSandbox(id: number) {
    router.push(`/sandbox/${id}`);
  }

  function formatDate(date: Date | null | undefined) {
    if (!date) return 'N/A';
    return new Date(date).toLocaleString();
  }

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-5xl mx-auto bg-white shadow-md rounded-lg p-6">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-2xl font-bold">My Sandboxes</h1>
          <div className="flex items-center gap-4">
            {user && (
              <span className="text-gray-600">
                {user.email}
              </span>
            )}
            <button
              onClick={logout}
              className="px-4 py-2 bg-gray-100 text-gray-700 rounded hover:bg-gray-200"
            >
              Logout
            </button>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded mb-6">
            {error}
          </div>
        )}

        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-4">Create New Sandbox</h2>
          <form onSubmit={createSandbox} className="bg-gray-50 p-4 rounded border border-gray-200">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Name*
                </label>
                <input
                  type="text"
                  value={newSandboxName}
                  onChange={(e) => setNewSandboxName(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="My Project"
                  required
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Description
                </label>
                <input
                  type="text"
                  value={newSandboxDescription}
                  onChange={(e) => setNewSandboxDescription(e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="Optional description"
                />
              </div>
            </div>
            <div className="mt-4 flex justify-end">
              <button
                type="submit"
                disabled={isCreating || !newSandboxName.trim()}
                className={`px-4 py-2 rounded text-white ${
                  isCreating || !newSandboxName.trim()
                    ? 'bg-blue-300'
                    : 'bg-blue-600 hover:bg-blue-700'
                }`}
              >
                {isCreating ? 'Creating...' : 'Create Sandbox'}
              </button>
            </div>
          </form>
        </div>

        <div>
          <h2 className="text-lg font-semibold mb-4">Your Sandboxes</h2>

          {loading ? (
            <div className="text-center py-8">
              <div className="inline-block w-8 h-8 border-4 border-gray-200 border-t-blue-600 rounded-full animate-spin"></div>
              <p className="mt-2 text-gray-600">Loading sandboxes...</p>
            </div>
          ) : sandboxes.length === 0 ? (
            <div className="text-center py-8 bg-gray-50 rounded border border-gray-200">
              <p className="text-gray-600">You don&apos;t have any sandboxes yet. Create one above!</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full border border-gray-200 rounded">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Description</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Last Accessed</th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                  </tr>
                </thead>
                <tbody className="bg-white divide-y divide-gray-200">
                  {sandboxes.map((sandbox) => (
                    <tr key={sandbox.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">{sandbox.name}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-500">{sandbox.description || '-'}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-500">{formatDate(sandbox.createdAt)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-gray-500">{formatDate(sandbox.lastAccessedAt)}</td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <button
                          onClick={() => openSandbox(sandbox.id)}
                          className="text-blue-600 hover:text-blue-900 mr-3"
                        >
                          Open
                        </button>
                        <button
                          onClick={() => deleteSandbox(sandbox.id)}
                          className="text-red-600 hover:text-red-900"
                        >
                          Delete
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
