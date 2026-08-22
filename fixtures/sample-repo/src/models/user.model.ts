// Pure type/model module with no internal imports — a leaf dependency.
export interface User {
  id: string;
  username: string;
  email: string;
  roles: string[];
}

export function createUser(partial: Partial<User> & { username: string }): User {
  return {
    id: partial.id ?? crypto.randomUUID(),
    username: partial.username,
    email: partial.email ?? '',
    roles: partial.roles ?? ['user'],
  };
}
