export function checkedPublicKey(value: string) {
  const key=value.trim();
  if(!/^ssh-ed25519 [A-Za-z0-9+/]{60,100}={0,2}(?: [a-zA-Z0-9@._-]+)?$/.test(key))throw new Error('需要有效的 Ed25519 公钥');
  return key;
}
export function authorizeKeyCommand(publicKey: string) {
  const key=checkedPublicKey(publicKey);
  return `install -d -m 700 /root/.ssh && touch /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && (grep -qxF '${key}' /root/.ssh/authorized_keys || printf '%s\\n' '${key}' >> /root/.ssh/authorized_keys)`;
}
export interface SshKeyInfo {publicKey:string;fingerprint:string;privateKeyPath:string;}
export function sshCommand(host:string,port:number,username:string,key?:SshKeyInfo) {
  return `ssh${key?` -i '${key.privateKeyPath.replaceAll("'","''")}' -o IdentitiesOnly=yes`:''} -p ${port} ${username}@${host}`;
}
