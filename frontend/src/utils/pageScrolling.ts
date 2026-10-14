/** Handle Home/End only when the page itself is focused; inputs and charts retain their keys. */
export function pageScrollKey(event:KeyboardEvent){
 if(event.target!==event.currentTarget||!['Home','End'].includes(event.key))return;
 const page=event.currentTarget as HTMLElement;
 const owner=getComputedStyle(page).overflowY==='visible'?page.closest<HTMLElement>('.mobile-layout'):page;
 if(!owner)return;
 event.preventDefault();owner.scrollTo({top:event.key==='End'?owner.scrollHeight:0,behavior:'instant'});
}
