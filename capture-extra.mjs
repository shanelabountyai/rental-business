import { chromium } from '@playwright/test'
import fs from 'node:fs'
const BASE='http://localhost:3100', OUT='/tmp/demo-shots'
const SCREENS=[
  ['entity','/properties/entities/cmthxu2or0000rds1xjoxa4rb/edit','Legal entity (edit is its only surface)'],
  ['unit','/properties/cmthxu3ic0061rds1ocft1x5z','Property with its units'],
]
const browser=await chromium.launch()
const ctx=await browser.newContext({viewport:{width:1440,height:900},
  extraHTTPHeaders:{'x-forwarded-for':`203.0.113.${Math.floor(Math.random()*250)+1}`}})
const page=await ctx.newPage()
await page.goto(BASE+'/login')
await page.getByLabel(/email/i).fill('owner@demo.test')
await page.getByLabel(/password/i).fill('demo-rental-2026')
await page.getByRole('button',{name:/sign in/i}).click()
await page.waitForURL('**/dashboard',{timeout:45000})
const out=[]
for(const [slug,path,title] of SCREENS){
  const res=await page.goto(BASE+path,{waitUntil:'domcontentloaded',timeout:45000}).catch(()=>null)
  await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{})
  const h1=await page.locator('h1').first().textContent({timeout:5000}).catch(()=>null)
  const file=`${OUT}/${slug}.png`
  await page.screenshot({path:file,fullPage:true})
  out.push({slug,path,title,status:res?res.status():0,heading:(h1||'').trim(),bytes:fs.statSync(file).size})
  console.log(`${String(res?res.status():0).padEnd(4)} ${slug.padEnd(12)} ${(h1||'(no h1)').trim().slice(0,44)}`)
}
fs.writeFileSync(`${OUT}/manifest-extra.json`,JSON.stringify(out,null,2))
const m=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,
  extraHTTPHeaders:{'x-forwarded-for':'203.0.113.77'}})
const mp=await m.newPage()
await mp.goto(BASE+'/login'); await mp.getByLabel(/email/i).fill('owner@demo.test')
await mp.getByLabel(/password/i).fill('demo-rental-2026')
await mp.getByRole('button',{name:/sign in/i}).click()
await mp.waitForURL('**/dashboard',{timeout:45000})
await mp.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{})
await mp.screenshot({path:`${OUT}/mobile-dashboard.png`,fullPage:true})
console.log('200  mobile-dashboard  390px')
await browser.close()
