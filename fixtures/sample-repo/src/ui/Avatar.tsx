import { type User } from '../models/user.model.js';

// A JSX/TSX file to exercise the parser's TSX handling.
export function Avatar(props: { user: User }) {
  const { user } = props;
  return <div className="avatar" title={user.username}>{user.username[0]}</div>;
}
