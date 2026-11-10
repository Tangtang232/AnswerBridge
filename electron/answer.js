const statusNames={empty:'等待问题',queued:'等待处理',generating:'正在回答',done:'回答完成',error:'回答失败'};
window.answerWindow.onUpdate(data=>{
 document.getElementById('status').textContent=statusNames[data.status]||'等待问题';
 document.getElementById('question').textContent=data.question||'';
 document.getElementById('answer').textContent=data.answer||(data.status==='error'?'':data.status==='empty'?'提交问题后，答案会显示在这里。':'正在准备答案…');
 const error=document.getElementById('error');error.hidden=!data.error;error.textContent=data.error||'';
 document.getElementById('demo').hidden=!data.demo;
 document.getElementById('protection').textContent=data.protection?'置顶显示 · 共享保护已开启，请先验证':'置顶显示 · 共享保护已关闭';
});
document.getElementById('opacity').addEventListener('input',e=>window.answerWindow.setOpacity(Number(e.target.value)/100));
