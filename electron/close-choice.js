document.getElementById('minimize').addEventListener('click',()=>window.closeChoice.select(0));
document.getElementById('quit').addEventListener('click',()=>window.closeChoice.select(1));
document.getElementById('cancel').addEventListener('click',()=>window.closeChoice.select(2));
document.addEventListener('keydown',event=>{if(event.key==='Escape')window.closeChoice.select(2)});
