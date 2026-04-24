import express from "express"
import cors from 'cors'

const app=express()
app.use(express.json())
app.use(cors())

app.get("/",(req,res)=>{
    res.send("SERVER UP AND RUNNING ")
})

const PORT=8000

app.listen(PORT,()=>{
    console.log(`SERVER UP AND RUNNING ON ${PORT}`)
})