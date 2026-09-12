import type {ReactNode} from 'react';

export function WorkspaceHeading({title,description,children}:{title:string;description:string;children?:ReactNode}) {
  return <header className="workspace-heading"><div><h1>{title}</h1><p>{description}</p></div>{children&&<div className="workspace-heading-actions">{children}</div>}</header>;
}
