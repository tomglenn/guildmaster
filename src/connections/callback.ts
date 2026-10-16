import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { AppError } from '../domain/types.ts';

/** A short-lived listener for the published Slack connector's registered redirect. */
export class SlackCallback {
  private server?:Server;
  private port:number;
  constructor(port=3118) {this.port=port;}
  url() {return `http://localhost:${this.port}/callback`;}
  async start(callback:(state:string|null,code:string|null,denied:boolean)=>Promise<boolean>) {
    if(this.server?.listening)return;
    const server=createServer(async(req,res)=>{
      const host=req.headers.host;
      if(!new Set([`localhost:${this.port}`,`127.0.0.1:${this.port}`,`[::1]:${this.port}`]).has(host ?? '')){res.writeHead(403);res.end();return;}
      const url=new URL(req.url ?? '/','http://localhost');
      if(req.method!=='GET'||url.pathname!=='/callback'){res.writeHead(404);res.end();return;}
      let ok=false;const denied=url.searchParams.has('error');
      try{ok=await callback(url.searchParams.get('state'),url.searchParams.get('code'),denied);}catch{/* Never echo codes, state, or provider errors into the page. */}
      res.writeHead(ok||denied?200:400,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});
      res.end(`<html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Guildmaster Slack connection</title><body style="font:16px system-ui;padding:40px;background:#191a1c;color:#e9e9ec"><h1>${ok?'Slack connected':denied?'Slack sign-in cancelled':'Slack sign-in did not complete'}</h1><p>Return to Guildmaster Settings → Connections${ok||denied?'.':' to check the connection and try again.'}</p></body></html>`);
    });
    this.server=server;
    try{
      await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(this.port,'localhost',()=>{server.off('error',reject);resolve();});});
      this.port=(server.address() as {port:number}).port;
    }catch{this.server=undefined;server.close();throw new AppError('Slack sign-in could not start because its callback port is busy. Finish sign-in in your other app, then try again.',409);}
  }
  stop() {const server=this.server;this.server=undefined;server?.close();server?.closeIdleConnections();}
}
