export interface DockerContext {name:string;endpoint:string;current:boolean;}
export interface DockerEngine {id:string;name:string;context:string;endpoint:string;serverId:string;version?:string;kind?:'external'|'managed';}
export interface DockerPort {hostAddress:string;hostPort:number;targetPort:number;guestPort?:number;protocol:'tcp'|'udp';active:boolean;}
export interface DockerContainer {id:string;name:string;image:string;state:string;owned:boolean;projectId?:string;ports:DockerPort[];createdAt:string;}
export interface DockerImage {id:string;name:string;size:string;}
export interface DockerProject {id:string;engineId:string;name:string;composeName:string;filePath:string;createdAt:string;}
export interface Operation {id:string;kind:string;resourceId?:string;state:'running'|'succeeded'|'failed';message:string;createdAt:string;updatedAt:string;}
export interface DockerSnapshot {available:boolean;contexts:DockerContext[];engine?:DockerEngine;containers:DockerContainer[];images:DockerImage[];projects:DockerProject[];operations:Operation[];managed?:import('./docker-managed').ManagedAvailability;error?:string;}
