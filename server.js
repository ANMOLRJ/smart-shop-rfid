const app=require('./api');
const port=process.env.PORT||3000;
app.listen(port,()=>console.log(`API listening on http://localhost:${port}`));
